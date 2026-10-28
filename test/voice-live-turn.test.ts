import { expect, it } from 'vitest'
import { decide, END_PHRASES } from '../extensions/voice-live/turn.ts'

const auto = { turns: 'auto' as const, holdMs: 12_000, endPhrases: END_PHRASES }

it('holds lines that were cut off mid-thought, even when Smart Turn calls them finished', () => {
  // Real cuts: Smart Turn said complete (p 0.99) on "Currently grip mode." and nothing on "Would this mean putting".
  expect(decide('Would this mean putting', {}, auto)).toMatchObject({ kind: 'hold', ms: 12_000 })
  expect(
    decide('I want to talk about.', { complete: true, probability: 0.83 }, auto),
  ).toMatchObject({
    kind: 'hold',
    ms: 12_000,
  })
  expect(
    decide('Currently group mode.', { complete: true, probability: 0.99 }, auto),
  ).toMatchObject({
    kind: 'hold',
  })
  expect(
    decide("Yes, that's what I mean.", { complete: true, probability: 0.89 }, auto),
  ).toMatchObject({
    kind: 'hold',
  })
  expect(decide('What else did he add?', { complete: true, probability: 0.97 }, auto)).toEqual({
    kind: 'send',
    text: 'What else did he add?',
    why: 'finished',
  })
  expect(decide('Yes.', { complete: true, probability: 0.95 }, auto)).toMatchObject({
    kind: 'send',
  })
})

it('ends the turn on an end phrase, waits on request, and switches to dictation by voice', () => {
  expect(decide('Add a parse function, over.', { probability: 0.2 }, auto)).toEqual({
    kind: 'send',
    text: 'Add a parse function',
    why: 'end phrase',
  })
  expect(decide('So the thing is, hold on.', {}, auto)).toMatchObject({
    kind: 'hold',
    ms: 30_000,
    text: 'So the thing is',
  })
  expect(decide('Dictation mode.', {}, auto)).toEqual({ kind: 'mode', turns: 'dictation' })
  expect(decide('Normal mode', {}, auto)).toEqual({ kind: 'mode', turns: 'auto' })
  const dictation = { ...auto, turns: 'dictation' as const }
  expect(
    decide('What else did he add?', { complete: true, probability: 0.99 }, dictation),
  ).toMatchObject({
    kind: 'hold',
    ms: 30_000,
  })
  expect(decide('What else did he add? Send it.', {}, dictation)).toMatchObject({ kind: 'send' })
})
