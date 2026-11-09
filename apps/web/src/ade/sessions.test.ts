import { describe, expect, it } from 'vitest'
import { agentCommand, agentTitle, MAX_SESSIONS, NO_TABS, nextAgentName, nextShellTitle, type Session, shq, slug, tabsReducer } from './sessions'

const shell = (id: string, title = id): Session => ({ id, title, kind: 'shell' })

describe('nextAgentName', () => {
  it('starts at 1 and fills the smallest gap', () => {
    expect(nextAgentName('cam', [])).toBe('cam-opus-1')
    expect(nextAgentName('cam', ['cam-opus-1', 'cam-opus-3'])).toBe('cam-opus-2')
    expect(nextAgentName('cam', ['cam-opus-1', 'cam-opus-2', 'jake-opus-3'])).toBe('cam-opus-3')
  })
  it('makes the name shell-safe', () => {
    expect(nextAgentName('Cam Hess', [])).toBe('cam-hess-opus-1')
    expect(slug("$(rm -rf ~)'")).toBe('rm-rf')
    expect(slug('!!')).toBe('me')
  })
})

describe('agentCommand', () => {
  it('quotes every value', () => {
    expect(agentCommand('http://localhost:3000', 'hh', 'cam-opus-1', 'backend')).toBe(
      "JAM_URL='http://localhost:3000' JAM_TEAM='hh' ./scripts/jam-agent.sh 'cam-opus-1' 'backend'",
    )
    expect(agentCommand('https://x', "a'b", 'cam-opus-2', 'frontend')).toBe("JAM_URL='https://x' JAM_TEAM='a'\\''b' ./scripts/jam-agent.sh 'cam-opus-2' 'frontend'")
  })
  it('echoes in dry mode', () => {
    expect(agentCommand('http://x', 'hh', 'cam-opus-1', 'backend', true)).toBe("echo AGENT 'cam-opus-1'")
  })
  it('shq survives quotes', () => {
    expect(shq("it's")).toBe("'it'\\''s'")
  })
})

describe('titles', () => {
  it('shortens agent names for their human', () => {
    expect(agentTitle('cam-opus-1', 'cam')).toBe('opus-1')
    expect(agentTitle('jake-opus-1', 'cam')).toBe('jake-opus-1')
  })
  it('numbers shells', () => {
    expect(nextShellTitle([])).toBe('shell')
    expect(nextShellTitle([shell('a', 'shell')])).toBe('shell 2')
    expect(nextShellTitle([shell('a', 'shell 2')])).toBe('shell')
  })
})

describe('tabsReducer', () => {
  it('adds and activates, up to the cap', () => {
    let s = NO_TABS
    for (let i = 0; i < MAX_SESSIONS + 2; i++) s = tabsReducer(s, { t: 'add', s: shell(`s${i}`) })
    expect(s.list).toHaveLength(MAX_SESSIONS)
    expect(s.active).toBe(`s${MAX_SESSIONS - 1}`)
  })
  it('closing the active tab moves to a neighbour, then back to the feed', () => {
    let s = tabsReducer(tabsReducer(NO_TABS, { t: 'add', s: shell('a') }), { t: 'add', s: shell('b') })
    s = tabsReducer(s, { t: 'show', id: 'a' })
    s = tabsReducer(s, { t: 'close', id: 'a' })
    expect(s).toEqual({ list: [shell('b')], active: 'b' })
    s = tabsReducer(s, { t: 'close', id: 'b' })
    expect(s).toEqual({ list: [], active: null })
  })
  it('closing an inactive tab keeps the active one; unknown ids are ignored', () => {
    let s = tabsReducer(tabsReducer(NO_TABS, { t: 'add', s: shell('a') }), { t: 'add', s: shell('b') })
    s = tabsReducer(s, { t: 'close', id: 'a' })
    expect(s.active).toBe('b')
    expect(tabsReducer(s, { t: 'show', id: 'zzz' })).toBe(s)
    expect(tabsReducer(s, { t: 'show', id: null }).active).toBeNull()
  })
})
