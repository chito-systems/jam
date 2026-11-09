import { describe, expect, it } from 'vitest'
import { clampPanel } from '../src/ade/term'
import { encodeInput, encodeResize, isAllowedOrigin, parseClientMessage } from './protocol'

describe('bridge origin allowlist', () => {
  it.each(['http://localhost:5173', 'http://localhost', 'http://127.0.0.1:4173', 'https://jam.cnh.radarhq.io'])('allows %s', (o) => {
    expect(isAllowedOrigin(o)).toBe(true)
  })
  it.each([
    undefined,
    '',
    'null',
    'http://localhost.evil.com',
    'http://localhost:5173.evil.com',
    'http://127.0.0.1.evil.com',
    'https://jam.cnh.radarhq.io.evil.com',
    'http://jam.cnh.radarhq.io',
    'https://localhost:5173',
    'http://evil.com',
    'http://localhost:5173/',
  ])('refuses %s', (o) => {
    expect(isAllowedOrigin(o)).toBe(false)
  })
  it('adds exact origins from JAM_BRIDGE_ORIGINS', () => {
    const extra = 'https://a.example, https://b.example'
    expect(isAllowedOrigin('https://b.example', extra)).toBe(true)
    expect(isAllowedOrigin('https://b.example.evil.com', extra)).toBe(false)
    expect(isAllowedOrigin('', ',')).toBe(false)
  })
})

describe('bridge messages', () => {
  it('round-trips input and resize', () => {
    expect(parseClientMessage(encodeInput('echo hi\n'))).toEqual({ t: 'in', d: 'echo hi\n' })
    expect(parseClientMessage(encodeResize(120, 40))).toEqual({ t: 'resize', cols: 120, rows: 40 })
  })
  it.each(['', 'nope', 'null', '[]', '{"t":"in"}', '{"t":"in","d":5}', '{"t":"resize","cols":0,"rows":10}', '{"t":"resize","cols":1.5,"rows":10}', '{"t":"resize","cols":"80","rows":24}', '{"t":"exec","d":"ls"}'])(
    'drops %s',
    (raw) => {
      expect(parseClientMessage(raw)).toBeNull()
    },
  )
})

describe('panel height', () => {
  it('clamps between 120px and 70% of the viewport', () => {
    expect(clampPanel(50, 1000)).toBe(120)
    expect(clampPanel(300, 1000)).toBe(300)
    expect(clampPanel(900, 1000)).toBe(700)
    expect(clampPanel(300, 100)).toBe(120)
  })
})
