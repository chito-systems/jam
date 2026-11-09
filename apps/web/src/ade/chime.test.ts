import { describe, expect, it } from 'vitest'
import { CHIMES, type ChimeName, PEAK, playChime } from './chime'

const names = Object.keys(CHIMES) as ChimeName[]

describe('chimes', () => {
  it('has every chime the UI plays', () => {
    expect(names.sort()).toEqual(['cancel', 'done', 'error', 'sent', 'start'])
  })
  it.each(names)('%s is short, soft and audible', (name) => {
    const { overtone, notes } = CHIMES[name]
    expect(notes.length).toBeGreaterThan(0)
    expect(overtone).toBeGreaterThan(1)
    for (const n of notes) {
      expect(n.f).toBeGreaterThan(60)
      expect(n.f * overtone).toBeLessThan(16000)
      expect(n.t).toBeGreaterThanOrEqual(0)
      expect(n.d).toBeGreaterThan(0)
      expect(n.g ?? 1).toBeLessThanOrEqual(1)
    }
    expect(Math.max(...notes.map((n) => n.t + n.d))).toBeLessThanOrEqual(1.5)
    const starts = notes.map((n) => n.t)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })
  it('gives start two notes and done a 3 to 4 note rising motif', () => {
    expect(CHIMES.start.notes).toHaveLength(2)
    const done = CHIMES.done.notes.map((n) => n.f)
    expect(done.length).toBeGreaterThanOrEqual(3)
    expect(done.length).toBeLessThanOrEqual(4)
    expect(done).toEqual([...done].sort((a, b) => a - b))
  })
  it('keeps the peak modest and is a silent no-op before audio is unlocked', () => {
    expect(PEAK).toBeLessThanOrEqual(0.15)
    expect(() => playChime('done')).not.toThrow()
  })
})
