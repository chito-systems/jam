import { describe, expect, it } from 'vitest'
import { MARK_SHAPES, MARK_VENDORS, markFor } from './Mark'

describe('markFor', () => {
  it('gives known agents their own ink and shape', () => {
    expect(markFor('feed')).toEqual({ ink: 'pink', shape: 'tri2' })
    expect(markFor('jam')).toEqual({ ink: 'teal', mis: 'yellow', shape: 'ring5' })
    expect(markFor('gitar')).toEqual({ ink: 'indigo', mis: 'pink', shape: 'gitar' })
  })

  it('ignores the agent: prefix', () => {
    expect(markFor('agent:opus-1')).toEqual(markFor('opus-1'))
  })

  it('gives an unknown agent the same mark every time', () => {
    const a = markFor('agent:haiku-7')
    expect(markFor('haiku-7')).toEqual(a)
    expect(a.ink).not.toBe('ghost')
  })

  it('spreads unknown agents across every shape and most inks', () => {
    const marks = Array.from({ length: 200 }, (_, i) => markFor(`agent:worker-${i}`))
    expect(marks.every((m) => !MARK_VENDORS.includes(m.shape as never))).toBe(true)
    expect(new Set(marks.map((m) => m.shape)).size).toBe(MARK_SHAPES.length)
    expect(new Set(marks.map((m) => m.ink)).size).toBeGreaterThanOrEqual(6)
    expect(marks.some((m) => m.mis)).toBe(true)
    expect(marks.every((m) => m.mis !== m.ink)).toBe(true)
  })

  it('rarely gives two of a team the same look', () => {
    const team = ['reviewer', 'planner', 'tester', 'scout', 'builder', 'linter', 'deployer', 'writer']
    const looks = new Set(team.map((n) => JSON.stringify(markFor(n))))
    expect(looks.size).toBeGreaterThanOrEqual(7)
  })
  it('dresses each model family in its own silhouette', () => {
    expect(markFor('agent:opus-1').shape).toBe('claude')
    expect(markFor('fable').shape).toBe('claude')
    expect(markFor('agent:Claude-Sonnet').shape).toBe('claude')
    expect(markFor('gpt-5').shape).toBe('openai')
    expect(markFor('codex-2').shape).toBe('openai')
    expect(markFor('o3-mini').shape).toBe('openai')
    expect(markFor('gemini-pro').shape).toBe('gemini')
    expect(markFor('llama-3').shape).toBe('meta')
    expect(markFor('grok-2').shape).toBe('grok')
  })

  it('still prints each agent of a family differently', () => {
    const team = ['opus-1', 'opus-2', 'sonnet-1', 'sonnet-2', 'haiku-1', 'fable'].map((n) => markFor(n))
    expect(new Set(team.map((m) => m.v)).size).toBe(team.length)
    expect(team.every((m) => m.mis && m.mis !== m.ink)).toBe(true)
  })

  it('does not mistake ordinary words for a model', () => {
    expect(markFor('scout').shape).not.toBe('openai')
    expect(markFor('builder-2').shape).not.toBe('openai')
  })
})
