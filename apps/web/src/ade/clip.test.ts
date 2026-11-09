import { describe, expect, it } from 'vitest'
import { clipName, MIN_CLIP_MS, micProblem, pickMime, tooShort } from './clip'

describe('voice clips', () => {
  it('discards holds shorter than half a second', () => {
    expect(MIN_CLIP_MS).toBe(500)
    expect(tooShort(499)).toBe(true)
    expect(tooShort(500)).toBe(false)
  })
  it('prefers webm opus, then webm, then mp4, else lets the browser choose', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickMime((m) => m === 'audio/mp4')).toBe('audio/mp4')
    expect(pickMime(() => false)).toBe('')
  })
  it('names the file for when recording started, like the capture page', () => {
    expect(clipName('2026-11-09T21:14:03.120Z', 'audio/webm;codecs=opus')).toBe('voice-2026-11-09T21-14-03-120Z.webm')
    expect(clipName('2026-11-09T21:14:03.120Z', 'audio/mp4')).toBe('voice-2026-11-09T21-14-03-120Z.mp4')
    expect(clipName('2026-11-09T21:14:03.120Z', '')).toBe('voice-2026-11-09T21-14-03-120Z.webm')
  })
  it('explains why the mic is unavailable', () => {
    expect(micProblem({ secure: false, media: false, recorder: false })).toMatch(/https or localhost/)
    expect(micProblem({ secure: true, media: true, recorder: false })).toMatch(/cannot record/)
    expect(micProblem({ secure: true, media: true, recorder: true })).toBeNull()
  })
})
