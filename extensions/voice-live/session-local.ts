/**
 * The local engine's browser side: the microphone, a level gate that cuts utterances at a short pause, the speak
 * extension's open models for words (Parakeet) and speech (Kokoro), half-duplex. Same shape as `startLive`.
 */
import { actionRef } from '../../shared/extension-api.ts'
import { PAUSES } from './pause.ts'
import { EndAction, HeardAction, StartLocalAction } from './refs.ts'
import type { VoicePause } from './refs.ts'
import { decide, END_PHRASES } from './turn.ts'
import type { VoiceTurns } from './turn.ts'
import type { LiveOptions, LiveSession } from './session.ts'

type Transcript = {
  text: string
  raw?: string
  speech: boolean
  complete?: boolean
  probability?: number
  ms: number
}
const TranscribeAction = actionRef<{ pcm: string; turn?: boolean }, Transcript>(
  'speak',
  'transcribe',
)
const WarmAction = actionRef<null, { ms: number }>('speak', 'sttWarm')
const RenderAction = actionRef<
  { text: string; voice: string; rate?: number; engine: 'mlx'; model: string },
  { audio: string; mimeType: string }
>('speak', 'render')
const SpeechifyAction = actionRef<{ text: string }, { text: string; ms: number }>(
  'speak',
  'speechify',
)

const RATE = 16_000
/** While the user talks, the words so far are transcribed this often for the live line. */
const PARTIAL_MS = 1000
/** Audio kept from before speech started, so its first syllable is not clipped. */
const PREROLL_MS = 300
/** Mic stays deaf this long after speech playback ends: the room's echo tail. */
const ECHO_TAIL_MS = 350
/** A turn this long goes as it is, so dictation never grows past what transcribes quickly. */
const MAX_MS = 120_000
/** A sentence whose `ended` never comes (a stalled audio context) is given up this long after its length. */
const PLAY_SLACK_MS = 3000
/** The audio context has not been running this long: the browser holds it, and a tap must resume it. */
const BLOCKED_MS = 1500

/** What to say for tokens a speech model reads badly: `@ultimate` → "Ultimate", `#1234` → "a branch", a URL → its domain. */
export function speakable(text: string) {
  return text
    .replace(
      /\bhttps?:\/\/(?:www\.)?([^\s/?#:]+)[^\s]*?(?=[.,;:!?)\]]*(?:\s|$))/g,
      (_, host: string) => host.split('.').join(' dot '),
    )
    .replace(
      /(^|[^\w.])@([a-z][\w-]*)/gi,
      (_, before: string, name: string) => before + name[0].toUpperCase() + name.slice(1),
    )
    .replace(
      /\b(?:(the|a)\s+)?(branch|conversation)\s+#?\d+\b/gi,
      (_, article: string | undefined, noun: string) => `${article ?? 'a'} ${noun.toLowerCase()}`,
    )
    .replace(/(^|[^\w&])#\d+\b/g, '$1a branch')
}

/** Sentences to speak one at a time, so the first one plays while the rest render. */
export function sentences(text: string) {
  return (text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [text])
    .map((part) => part.trim())
    .filter(Boolean)
}

/** Downsample float audio at `from` Hz to 16 kHz int16. */
function toPcm(chunks: Float32Array[], from: number) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  const ratio = from / RATE
  const out = new Int16Array(Math.floor(total / ratio))
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio
    const low = Math.floor(at)
    const high = Math.min(low + 1, total - 1)
    const sample = joined[low] + (joined[high] - joined[low]) * (at - low)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
  }
  const bytes = new Uint8Array(out.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** The voice speak's settings chose for its open model, so read-aloud and voice sound the same. */
function voiceOf() {
  const rate = Number(localStorage.getItem('speak:rate'))
  return {
    engine: 'mlx' as const,
    model: localStorage.getItem('speak:mlx-model') || 'mlx-community/Kokoro-82M-bf16',
    voice: localStorage.getItem('speak:mlx-voice') || 'af_heart',
    ...(rate >= 0.5 && rate <= 3 ? { rate } : {}),
  }
}

export async function startLocal(
  options: LiveOptions & {
    /** A finished line is on its way to Voice: the soft end-of-speech cue. */
    onLine?: () => void
  },
): Promise<LiveSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  // Created inside the tap, so it may play speech later without another gesture.
  const audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  source.connect(analyser)
  // A deprecated node, but the one every browser runs without a module file.
  const capture = audioContext.createScriptProcessor(2048, 1, 1)
  const sink = audioContext.createGain()
  sink.gain.value = 0
  source.connect(capture)
  capture.connect(sink).connect(audioContext.destination)
  const frameMs = (2048 / audioContext.sampleRate) * 1000
  const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  // Until the server's setting arrives with the session: the default.
  let pause: VoicePause = PAUSES.relaxed
  let frameAt = Date.now()
  // Since when the audio context is not running (suspended or iOS `interrupted`); 0 while it runs.
  let stoppedSince = 0
  const running = () => audioContext.state === 'running'
  audioContext.addEventListener('statechange', () => {
    if (running()) stoppedSince = 0
    else if (audioContext.state !== 'closed') {
      stoppedSince ||= Date.now()
      // Without a gesture this may stay suspended; then the tab offers a tap to resume.
      audioContext.resume().catch((error: unknown) => console.warn('Voice: audio held', error))
    }
  })

  let conversation: number | undefined
  let releasing = false
  let muted = false
  let began = Date.now()
  let activityAt = Date.now()
  // The utterance being heard: its audio, when it last had speech, and what the newest transcription said.
  let heard: Float32Array[] = []
  let preroll: Float32Array[] = []
  let voicedAt = 0
  let quietSince = 0
  let words = ''
  // What Parakeet heard of `words` before the lexicon put terms right, when that differs.
  let raw: string | undefined
  let cut: 'none' | 'pending' | 'held' = 'none'
  // While held: how much more quiet the line gets, and why it is held.
  let holdMs = 0
  let turns: VoiceTurns = 'auto'
  let endPhrases = END_PHRASES
  let partialAt = 0
  let partialBusy = false
  let floor = 0.004
  let pending = Promise.resolve()
  // Speech playback: sentences queued in order, the one playing, deaf until.
  let playing: AudioBufferSourceNode | undefined
  let queue: { audio: Promise<AudioBuffer | undefined>; words: number; first: boolean }[] = []
  let draining = false
  let talkingUntil = 0
  let spoken = 0
  let generation = 0

  type Line = { raw?: string; unsure?: boolean }
  const send = (text: string, line: Line) => {
    pending = pending
      .then(async () => {
        await options.action(HeardAction, {
          text,
          ...(line.raw ? { raw: line.raw } : {}),
          ...(line.unsure ? { unsure: true } : {}),
        })
      })
      .catch((error: unknown) => options.onError(errorOf(error)))
  }
  const reset = () => {
    heard = []
    words = ''
    raw = undefined
    cut = 'none'
    holdMs = 0
    voicedAt = 0
    quietSince = 0
  }
  /** `unsure`: the turn ended without a sign it was finished (a hold ran out, the session closed). */
  const finish = (text: string, line: Line = {}) => {
    reset()
    if (!text) return
    options.onLine?.()
    send(text, line)
  }
  const transcribe = async (turn: boolean) =>
    options.action(TranscribeAction, { pcm: toPcm(heard, audioContext.sampleRate), turn })
  // The newest flush's transcription, which closing waits for; it never rejects.
  let flushing = Promise.resolve()
  /** Deliver what is heard so far, whatever Smart Turn would say: words held, else the audio transcribed now. */
  const flush = () => {
    if (!heard.length || cut === 'pending') return
    if (cut === 'held') return finish(words, { raw, unsure: true })
    const audio = heard
    reset()
    flushing = options
      .action(TranscribeAction, { pcm: toPcm(audio, audioContext.sampleRate), turn: false })
      .then((result) => {
        if (result.speech && result.text) finish(result.text, { raw: result.raw, unsure: true })
      })
      .catch((error: unknown) => options.onError(errorOf(error)))
  }
  // Frames stopped coming mid-utterance (the browser holds the audio): a held line still goes, never dropped.
  const stall = setInterval(() => {
    if (heard.length && Date.now() - frameAt > pause.cutMs + Math.max(holdMs, pause.holdMs)) flush()
  }, 500)

  /**
   * At a short pause: transcribe all of the turn so far and let the turn rules judge it. A finished line goes; any
   * doubt holds the floor, and speech that resumes is transcribed again with the rest, so Voice gets one line.
   */
  const cutNow = () => {
    cut = 'pending'
    const length = heard.length
    void transcribe(true)
      .then((result) => {
        // The session ended while this was out: its words still go.
        if (releasing)
          return void (
            result.speech &&
            result.text &&
            finish(result.text, { raw: result.raw, unsure: true })
          )
        if (cut !== 'pending') return
        // Speech resumed while this was out: the next pause transcribes the whole of it again.
        if (heard.length !== length && voicedAt > quietSince) return void (cut = 'none')
        if (!result.speech) return reset()
        const turn = decide(result.text, result, { turns, holdMs: pause.holdMs, endPhrases })
        console.info(
          'Voice: turn',
          turn.kind,
          'why' in turn ? turn.why : turn.turns,
          result.probability,
        )
        if (turn.kind === 'mode') {
          reset()
          turns = turn.turns
          speak(
            turns === 'dictation'
              ? 'Dictation mode. Take your time, and say over when you are done.'
              : 'Normal mode.',
          )
          return
        }
        words = turn.text
        raw = result.raw
        if (turn.kind === 'send') finish(turn.text, { raw })
        else {
          cut = 'held'
          holdMs = turn.ms
        }
      })
      .catch((error: unknown) => {
        reset()
        options.onError(errorOf(error))
      })
  }
  const partial = () => {
    partialBusy = true
    partialAt = Date.now()
    void transcribe(false)
      .then((result) => {
        if (cut === 'none' && heard.length && result.speech) words = result.text
      })
      .catch(() => {
        // A lost partial only delays the live words until the next one or the cut; the cut reports its own failure.
      })
      .finally(() => (partialBusy = false))
  }

  capture.onaudioprocess = (event) => {
    if (releasing) return
    const now = Date.now()
    frameAt = now
    const input = new Float32Array(event.inputBuffer.getChannelData(0))
    // Half-duplex: only while speech actually plays (and its echo dies down) is the microphone not heard.
    if (muted || playing || now < talkingUntil) {
      preroll = []
      return
    }
    let sum = 0
    for (const sample of input) sum += sample * sample
    const level = Math.sqrt(sum / input.length)
    const voiced = level > Math.max(0.012, floor * 3)
    if (!voiced) floor = floor * 0.95 + level * 0.05
    if (!heard.length) {
      if (!voiced) {
        preroll.push(input)
        if (preroll.length * frameMs > PREROLL_MS) preroll.shift()
        return
      }
      heard = [...preroll, input]
      preroll = []
      voicedAt = now
      partialAt = now
      activityAt = now
      return
    }
    heard.push(input)
    if (voiced) {
      voicedAt = now
      activityAt = now
      quietSince = 0
      if (cut === 'held') cut = 'none'
    } else quietSince ||= now
    const quiet = quietSince ? now - quietSince : 0
    if (heard.length * frameMs > MAX_MS) flush()
    else if (cut === 'none' && quiet >= pause.cutMs) cutNow()
    else if (cut === 'held' && quiet >= pause.cutMs + holdMs) finish(words, { raw, unsure: true })
    else if (cut === 'none' && !quiet && !partialBusy && now - partialAt >= PARTIAL_MS) partial()
  }

  const render = (text: string, run: number) =>
    options.action(RenderAction, { ...voiceOf(), text }).then(async ({ audio }) => {
      if (run !== generation) return undefined
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))
      return audioContext.decodeAudioData(bytes.buffer)
    })
  /** Until the user's turn is over, or speech run `run` was stopped. */
  const userDone = (run: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (heard.length && run === generation) setTimeout(check, 100)
        else resolve()
      }
      check()
    })
  /** Play the queued sentences in order; each one's words count as spoken when it starts. */
  const drain = async (run: number) => {
    draining = true
    const current = () => run === generation
    try {
      while (current() && queue.length) {
        const next = queue[0]
        let buffer: AudioBuffer | undefined
        try {
          buffer = await next.audio
        } catch (error) {
          options.onError(errorOf(error))
        }
        if (run !== generation) return
        queue.shift()
        if (!buffer) continue
        // A held context plays nothing: wait for it (a tap resumes it) instead of waiting on an `ended` that never comes.
        if (!running()) {
          // Refused without a gesture: the tab shows Hear it after BLOCKED_MS, and its tap resumes.
          audioContext.resume().catch((error: unknown) => console.warn('Voice: audio held', error))
          await new Promise<void>((resolve) => {
            const check = () => {
              if (!running() && run === generation) return
              audioContext.removeEventListener('statechange', check)
              resolve()
            }
            audioContext.addEventListener('statechange', check)
            check()
          })
          if (run !== generation) return
        }
        // The user has the floor (mid-line, or holding it to think): the answer waits for their turn to end.
        if (next.first) await userDone(run)
        if (run !== generation) return
        const node = audioContext.createBufferSource()
        node.buffer = buffer
        node.connect(audioContext.destination)
        playing = node
        if (next.first) spoken = 0
        spoken += next.words
        activityAt = Date.now()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              console.warn('Voice: a sentence never ended; going on')
              resolve()
            },
            buffer.duration * 1000 + PLAY_SLACK_MS,
          )
          node.addEventListener(
            'ended',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
          node.start()
        })
        if (playing === node) {
          try {
            node.stop()
          } catch {
            /* Already ended. */
          }
        }
        playing = undefined
        // Its echo dies down before the microphone is heard again, between sentences too.
        talkingUntil = Date.now() + ECHO_TAIL_MS
      }
      talkingUntil = Date.now() + ECHO_TAIL_MS
      activityAt = Date.now()
    } finally {
      if (run === generation) draining = false
    }
  }
  const stopSpeaking = () => {
    generation++
    draining = false
    queue = []
    const node = playing
    playing = undefined
    try {
      node?.stop()
    } catch {
      /* Already ended. */
    }
    talkingUntil = Date.now() + ECHO_TAIL_MS
  }
  /** Queue a line after any speech still playing; each sentence renders while the one before plays. */
  const queueLine = (text: string, run: number) => {
    if (run !== generation) return
    for (const [index, part] of sentences(speakable(text)).entries())
      queue.push({
        audio: render(part, run),
        words: part.split(/\s+/).filter(Boolean).length,
        first: index === 0,
      })
    // drain reports a failed sentence itself and never rejects.
    if (!draining) void drain(run).catch((error: unknown) => options.onError(errorOf(error)))
  }
  // Lines still being rewritten for the ear, so a later line never overtakes one.
  let rewriting = Promise.resolve()
  const speak = (text: string, { forEar = false } = {}) => {
    if (releasing) return
    const run = generation
    rewriting = rewriting.then(async () => {
      if (releasing || run !== generation) return
      if (!forEar || localStorage.getItem('speak:speechify') === 'off') return queueLine(text, run)
      const rewritten = await options
        .action(SpeechifyAction, { text })
        .then((result) => result.text)
        .catch((error: unknown) => {
          console.warn('Voice: speechify failed, speaking the line as written', error)
          return text
        })
      queueLine(rewritten, run)
    })
  }

  const cleanup = async () => {
    if (releasing) return
    releasing = true
    clearInterval(stall)
    stopSpeaking()
    capture.onaudioprocess = null
    stream.getTracks().forEach((track) => track.stop())
    await audioContext.close()
  }
  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      // Words still being heard as the session ends go to Voice, not nowhere.
      if (!releasing) flush()
      await cleanup()
      await flushing
      await pending
      if (conversation !== undefined)
        await options.action(EndAction, { seconds: Math.round((Date.now() - began) / 1000) })
    })())

  try {
    await audioContext.resume()
    const [started] = await Promise.all([
      options.action(StartLocalAction, null),
      // Loads Parakeet, Silero and Smart Turn now, not on the first word.
      options.action(WarmAction, null),
    ])
    conversation = started.conversation
    pause = started.pause ?? PAUSES.relaxed
    turns = started.turns ?? 'auto'
    endPhrases = started.endPhrases ?? END_PHRASES
    // iOS ends the microphone when the screen locks or another app takes it: the session is over, and says why.
    for (const track of stream.getAudioTracks())
      track.addEventListener('ended', () => {
        if (releasing) return
        options.onError(
          new Error('The microphone stopped (screen locked or another app took it) · tap Resume'),
        )
        void close().catch((error: unknown) => options.onError(errorOf(error)))
      })
    began = Date.now()
    activityAt = began
    return {
      conversation,
      analyser,
      relay: {
        hearing: () => heard.length > 0,
        talking: () => playing !== undefined || queue.length > 0,
        partial: () => (heard.length ? words : ''),
        spokenWords: () => spoken,
        idleFor: (now) => Math.max(0, now - activityAt),
      },
      holding: () => cut === 'held',
      dictating: () => turns === 'dictation',
      // No GPT-Live to read quiet context: thinking notes have no listener here.
      send: () => undefined,
      mute: () => {
        muted = true
        reset()
      },
      unmute: () => {
        muted = false
      },
      speak,
      stopSpeaking,
      audioBlocked: () => stoppedSince > 0 && Date.now() - stoppedSince >= BLOCKED_MS,
      resumeAudio: () => audioContext.resume(),
      close,
    }
  } catch (error) {
    if (conversation !== undefined)
      await close().catch((cause: unknown) => options.onError(errorOf(cause)))
    else await cleanup()
    throw error
  }
}
