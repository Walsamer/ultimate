/**
 * The local engine's browser side: the microphone, a level gate that cuts utterances at a short pause, the speak
 * extension's open models for words (Parakeet) and speech (Kokoro), half-duplex. Same shape as `startLive`.
 */
import { actionRef } from '../../shared/extension-api.ts'
import { EndAction, HeardAction, StartLocalAction } from './refs.ts'
import type { LiveOptions, LiveSession } from './session.ts'

type Transcript = { text: string; speech: boolean; complete?: boolean; ms: number }
const TranscribeAction = actionRef<{ pcm: string; turn?: boolean }, Transcript>(
  'speak',
  'transcribe',
)
const WarmAction = actionRef<null, { ms: number }>('speak', 'sttWarm')
const RenderAction = actionRef<
  { text: string; voice: string; rate?: number; engine: 'mlx'; model: string },
  { audio: string; mimeType: string }
>('speak', 'render')

const RATE = 16_000
/** A pause this long cuts the utterance for transcription; Smart Turn then says whether the sentence is done. */
export const CUT_MS = 400
/** After Smart Turn calls a cut unfinished, this much more quiet sends it anyway. */
export const HOLD_MS = 1600
/** While the user talks, the words so far are transcribed this often for the live line. */
const PARTIAL_MS = 1000
/** Audio kept from before speech started, so its first syllable is not clipped. */
const PREROLL_MS = 300
/** Mic stays deaf this long after speech playback ends: the room's echo tail. */
const ECHO_TAIL_MS = 350
const MAX_MS = 30_000

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
  let cut: 'none' | 'pending' | 'held' = 'none'
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

  const send = (text: string) => {
    pending = pending
      .then(async () => {
        await options.action(HeardAction, { text })
      })
      .catch((error: unknown) => options.onError(errorOf(error)))
  }
  const reset = () => {
    heard = []
    words = ''
    cut = 'none'
    voicedAt = 0
    quietSince = 0
  }
  const finish = (text: string) => {
    reset()
    if (!text) return
    options.onLine?.()
    send(text)
  }
  const transcribe = async (turn: boolean) =>
    options.action(TranscribeAction, { pcm: toPcm(heard, audioContext.sampleRate), turn })

  /** At a short pause: transcribe what was said; send it when Smart Turn calls it finished, else hold. */
  const cutNow = () => {
    cut = 'pending'
    const length = heard.length
    void transcribe(true)
      .then((result) => {
        if (releasing || cut !== 'pending') return
        // Speech resumed while this was out: the next pause transcribes the whole of it again.
        if (heard.length !== length && voicedAt > quietSince) return void (cut = 'none')
        if (!result.speech) return reset()
        words = result.text
        if (result.complete !== false) finish(result.text)
        else cut = 'held'
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
    const input = new Float32Array(event.inputBuffer.getChannelData(0))
    // Half-duplex: while speech plays (and its echo dies down) the microphone is not heard.
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
    if (heard.length * frameMs > MAX_MS) cutNow()
    else if (cut === 'none' && quiet >= CUT_MS) cutNow()
    else if (cut === 'held' && quiet >= CUT_MS + HOLD_MS) finish(words)
    else if (cut === 'none' && !quiet && !partialBusy && now - partialAt >= PARTIAL_MS) partial()
  }

  const render = (text: string, run: number) =>
    options.action(RenderAction, { ...voiceOf(), text }).then(async ({ audio }) => {
      if (run !== generation) return undefined
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))
      return audioContext.decodeAudioData(bytes.buffer)
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
        const node = audioContext.createBufferSource()
        node.buffer = buffer
        node.connect(audioContext.destination)
        playing = node
        if (next.first) spoken = 0
        spoken += next.words
        activityAt = Date.now()
        await new Promise<void>((resolve) => {
          node.addEventListener('ended', () => resolve(), { once: true })
          node.start()
        })
        playing = undefined
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
  const speak = (text: string) => {
    const run = generation
    for (const [index, part] of sentences(text).entries())
      queue.push({
        audio: render(part, run),
        words: part.split(/\s+/).filter(Boolean).length,
        first: index === 0,
      })
    talkingUntil = Number.POSITIVE_INFINITY
    // A line cut mid-sentence leaves no partial utterance behind.
    reset()
    // drain reports a failed sentence itself and never rejects.
    if (!draining) void drain(run).catch((error: unknown) => options.onError(errorOf(error)))
  }

  const cleanup = async () => {
    if (releasing) return
    releasing = true
    stopSpeaking()
    capture.onaudioprocess = null
    stream.getTracks().forEach((track) => track.stop())
    await audioContext.close()
  }
  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      await cleanup()
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
      close,
    }
  } catch (error) {
    if (conversation !== undefined)
      await close().catch((cause: unknown) => options.onError(errorOf(cause)))
    else await cleanup()
    throw error
  }
}
