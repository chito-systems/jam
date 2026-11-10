import { describe, expect, it } from 'vitest'
import { keysFor, modsOff, SEQ_MS, SHORTCUTS, step, typingIn } from './shortcuts'

describe('step', () => {
  it('runs a g sequence within the window', () => {
    const g = step('g', null, 100)
    expect(g).toEqual({ pending: 100, handled: true })
    expect(step('j', g.pending, 100 + SEQ_MS)).toEqual({ action: 'jam', pending: null, handled: true })
  })
  it('drops a g that waited too long, and the late key acts alone', () => {
    expect(step('t', 0, SEQ_MS + 1)).toEqual({ action: 'shell', pending: null, handled: true })
    expect(step('j', 0, SEQ_MS + 1)).toEqual({ pending: null, handled: false })
  })
  it('lets an unknown second key fall through unhandled', () => {
    expect(step('x', 0, 10)).toEqual({ pending: null, handled: false })
  })
  it('maps digits to tabs and single keys to actions', () => {
    expect(step('3', null, 0)).toMatchObject({ action: 'tab', tab: 3 })
    expect(step('0', null, 0).handled).toBe(false)
    expect(step('?', null, 0).action).toBe('cheat')
    expect(step(',', null, 0).action).toBe('settings')
    expect(step('Escape', null, 0).action).toBe('escape')
  })
  it('never claims j or k, which the task list owns', () => {
    expect(step('j', null, 0).handled).toBe(false)
    expect(step('k', null, 0).handled).toBe(false)
  })
})

describe('typingIn', () => {
  const el = (tagName: string, inside = '') => ({ tagName, closest: (s: string) => (inside && s.includes(inside) ? {} : null) })
  it('ignores fields, terminals and the game', () => {
    expect(typingIn(el('TEXTAREA'))).toBe(true)
    expect(typingIn(el('DIV', '.xterm'))).toBe(true)
    expect(typingIn(el('BUTTON', '.fun-win'))).toBe(true)
    expect(typingIn({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
  it('keeps the page itself', () => {
    expect(typingIn(el('BODY'))).toBe(false)
    expect(typingIn(el('BUTTON'))).toBe(false)
    expect(typingIn(null)).toBe(false)
  })
})

it('modsOff is false with any modifier', () => {
  expect(modsOff({ altKey: false, metaKey: false, ctrlKey: false })).toBe(true)
  expect(modsOff({ altKey: true, metaKey: false, ctrlKey: false })).toBe(false)
})

it('every matchable shortcut has a unique sequence, and keysFor shows its keys', () => {
  const seqs = SHORTCUTS.flatMap((s) => (s.seq ? [s.seq] : []))
  expect(new Set(seqs).size).toBe(seqs.length)
  expect(keysFor('jam')).toBe('g j')
})
