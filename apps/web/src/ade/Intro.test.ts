import { describe, expect, it } from 'vitest'
import { MAX_MS, MIN_MS, shouldExit } from './Intro'

describe('intro exit', () => {
  it('waits for the print even when the data is already in', () => {
    expect(shouldExit({ elapsed: MIN_MS - 1, ready: true, skipped: false })).toBe(false)
    expect(shouldExit({ elapsed: MIN_MS, ready: true, skipped: false })).toBe(true)
  })
  it('holds for data, up to the cap', () => {
    expect(shouldExit({ elapsed: 2000, ready: false, skipped: false })).toBe(false)
    expect(shouldExit({ elapsed: MAX_MS, ready: false, skipped: false })).toBe(true)
  })
  it('a tap skips at any time', () => {
    expect(shouldExit({ elapsed: 0, ready: false, skipped: true })).toBe(true)
  })
})
