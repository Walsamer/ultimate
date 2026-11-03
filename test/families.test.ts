import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { definitionRuns, familyFallback, mergeFamilies, parseFamilies } from '../lib/families.ts'
import { readFamilies, readFamilyLayers, writeFamilies } from '../lib/families-settings.ts'
import { temp } from './helpers.ts'

const families = (value: unknown, project?: unknown) =>
  mergeFamilies(parseFamilies(value), parseFamilies(project))

it('runs a definition on its pin, else its family, else the default family', () => {
  const config = families({
    families: { fast: { model: 'acme/quick' }, local: { model: 'vllm/current', thinking: 'low' } },
    // An agent's family lives in its definition: an old settings assignment no longer moves it.
    assign: { 'agent/worker': 'local' },
  })
  const pin = { provider: 'acme', modelId: 'big' }
  expect(definitionRuns({ family: 'fast' }, config)).toEqual({
    family: 'fast',
    model: { provider: 'acme', modelId: 'quick' },
    via: 'family',
  })
  expect(definitionRuns({ model: pin, family: 'fast' }, config)).toEqual({
    model: pin,
    via: 'pin',
  })
  // The family's thinking applies unless the definition sets its own.
  expect(definitionRuns({ family: 'local' }, config).thinking).toBe('low')
  expect(definitionRuns({ family: 'local', thinking: 'max' }, config).thinking).toBe('max')
  // The default family runs the parent's model; an unknown family falls back to it.
  expect(definitionRuns({}, config)).toEqual({ family: 'default', via: 'family' })
  expect(definitionRuns({ family: 'gone' }, config)).toEqual({
    family: 'default',
    via: 'family',
  })
})

it('merges the project over the user over the built-ins, field by field', () => {
  const config = families(
    { families: { tiny: { model: 'acme/mini' }, local: { model: 'vllm/current' } } },
    { families: { tiny: { thinking: 'high' } } },
  )
  expect(config.families.tiny).toEqual({ model: 'acme/mini', thinking: 'high', color: 'emerald' })
  expect(config.families.local.model).toBe('vllm/current')
  expect(config.families.local.color).toBeTruthy()
  expect(() => parseFamilies({ families: { Bad: {} } })).toThrow('lowercase')
})

it("keeps a family's fallback per family, and refuses one that names the family's own model", () => {
  const config = families(
    { families: { fast: { model: 'acme/quick', fallback: 'acme/cheap' } } },
    { families: { fast: { thinking: 'high' } } },
  )
  // A later layer adds a field without restating the fallback.
  expect(config.families.fast).toEqual({
    model: 'acme/quick',
    thinking: 'high',
    fallback: 'acme/cheap',
    color: 'amber',
  })
  expect(familyFallback(config, 'fast')).toEqual({ provider: 'acme', modelId: 'cheap' })
  expect(familyFallback(config, 'default')).toBeUndefined()
  // A fallback changes nothing about what a conversation runs on: the default family still resolves no model of its
  // own, so its conversations keep the parent's model and only move when that one is gone.
  const withDefault = families({ families: { default: { fallback: 'acme/cheap' } } })
  expect(definitionRuns({ family: 'default' }, withDefault)).toEqual({
    family: 'default',
    via: 'family',
  })
  expect(familyFallback(withDefault, 'default')).toEqual({ provider: 'acme', modelId: 'cheap' })
  // A family's fallback is a model, never another family: no chain can point back at itself.
  expect(() => parseFamilies({ families: { fast: { fallback: 'tiny' } } })).toThrow('"provider/id"')
  expect(() =>
    parseFamilies({ families: { fast: { model: 'acme/quick', fallback: 'acme/quick' } } }),
  ).toThrow("must differ from the family's model")
})

it("keeps each project's families and starts a project without its own from the ones saved last", async () => {
  const userHome = await temp('ultimate-families-')
  const [a, b, c] = ['a', 'b', 'c'].map((name) => join(userHome, name))
  for (const root of [a, b, c]) await mkdir(root)
  const tiny = async (root: string) =>
    (await readFamilyLayers(userHome, root, {})).from +
    ' ' +
    (await readFamilies(userHome, root, {})).families.tiny.model
  expect(await tiny(a)).toBe('builtin openai-codex/gpt-6-luna')
  await writeFamilies(userHome, a, { families: { tiny: { model: 'vllm/a' } } })
  await writeFamilies(userHome, b, { families: { tiny: { model: 'vllm/b' } } })
  // Each keeps its own; a project that never saved starts from the last save, b's.
  expect(await tiny(a)).toBe('project vllm/a')
  expect(await tiny(b)).toBe('project vllm/b')
  expect(await tiny(c)).toBe('recent vllm/b')
  // The project's team settings apply over its own families.
  const team = { modelFamilies: { families: { tiny: { model: 'acme/team' } } } }
  expect((await readFamilies(userHome, a, team)).families.tiny.model).toBe('acme/team')
})
