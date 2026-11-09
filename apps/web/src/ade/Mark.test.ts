import { describe, expect, it } from 'vitest'
import { markFor } from './Mark'

describe('markFor', () => {
  it('gives known agents their own ink and shape', () => {
    expect(markFor('fable')).toEqual({ ink: 'blue', shape: 'ring5' })
  })

  it('ignores the agent: prefix', () => {
    expect(markFor('agent:opus-1')).toEqual(markFor('opus-1'))
  })

  it('gives an unknown agent the same mark every time', () => {
    const a = markFor('agent:haiku-7')
    expect(markFor('haiku-7')).toEqual(a)
    expect(a.ink).not.toBe('ghost')
  })
})
