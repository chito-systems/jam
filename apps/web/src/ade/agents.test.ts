import type { AgentDoc } from '@hh/shared'
import { describe, expect, it } from 'vitest'
import { agentMode, foldGone, groupAgents, ownerLabel, shortName } from './agents'

const agent = (over: Partial<AgentDoc>): AgentDoc => ({
  team_id: 'demo',
  id: 'agent:cam-opus-1',
  name: 'cam-opus-1',
  human: 'cam',
  side: 'backend',
  state: 'active',
  first_seen: '2026-11-09T19:00:00.000Z',
  last_seen: '2026-11-09T19:05:00.000Z',
  calls: 3,
  claims: [],
  ...over,
})

describe('shortName', () => {
  it('drops the human prefix', () => expect(shortName({ name: 'cam-opus-1', human: 'cam' })).toBe('opus-1'))
  it('keeps names without the prefix or without a human', () => {
    expect(shortName({ name: 'opus-1', human: 'cam' })).toBe('opus-1')
    expect(shortName({ name: 'cameron-opus', human: 'cam' })).toBe('cameron-opus')
    expect(shortName({ name: 'fable' })).toBe('fable')
    expect(shortName({ name: 'cam-', human: 'cam' })).toBe('cam-')
  })
  it('calls a session with no name of its own an unnamed session', () => {
    expect(shortName({ name: 'agent', human: 'agent' })).toBe('unnamed session')
    expect(shortName({ name: 'agent' })).toBe('unnamed session')
  })
})

describe('ownerLabel', () => {
  const known = new Map([['agent:cam-opus-1', agent({})]])
  it('names a known agent with its human', () => expect(ownerLabel('agent:cam-opus-1', known)).toBe('opus-1 · cam'))
  it('falls back to the bare name', () => {
    expect(ownerLabel('agent:jake-sonnet-1', known)).toBe('jake-sonnet-1')
    expect(ownerLabel('jake', known)).toBe('jake')
    expect(ownerLabel('agent:solo', new Map([['agent:solo', agent({ id: 'agent:solo', name: 'solo', human: undefined })]]))).toBe('solo')
  })
})

describe('agentMode', () => {
  const claim = { team_id: 'demo', id: 'k', title: 't', side: 'backend' as const, owner: 'agent:cam-opus-1', paths: [], status: 'claimed' as const, created_at: '', updated_at: '' }
  it('works while holding a claim, waits without one', () => {
    expect(agentMode({ state: 'active', claims: [claim] })).toBe('working')
    expect(agentMode({ state: 'active', claims: [] })).toBe('waiting')
    expect(agentMode({ state: 'idle', claims: [claim] })).toBe('idle')
    expect(agentMode({ state: 'gone', claims: [] })).toBe('still')
  })
})

describe('groupAgents', () => {
  it('puts agents under their person, keeps counts and order, and collects the rest', () => {
    const g = groupAgents({ jake: 2, cam: 5, 'agent:cam-opus-1': 4, 'agent:old': 1 }, [
      agent({}),
      agent({ id: 'agent:jake-sonnet-1', name: 'jake-sonnet-1', human: 'jake', side: 'frontend' }),
      agent({ id: 'agent:ana-opus-1', name: 'ana-opus-1', human: 'ana' }),
      agent({ id: 'agent:fable', name: 'fable', human: undefined }),
    ])
    expect(g.people.map((p) => [p.human, p.count, p.agents.map((a) => a.name)])).toEqual([
      ['cam', 5, ['cam-opus-1']],
      ['jake', 2, ['jake-sonnet-1']],
      ['ana', undefined, ['ana-opus-1']],
    ])
    expect(g.unassigned.map((a) => a.name)).toEqual(['fable'])
    expect(g.others).toEqual([['agent:old', 1]])
  })
})

describe('foldGone', () => {
  const gone = (n: number) => Array.from({ length: n }, (_, i) => agent({ id: `agent:g${i}`, name: `g${i}`, state: 'gone' }))
  it('folds more than three gone agents unless opened', () => {
    const list = [agent({}), ...gone(4)]
    expect(foldGone(list, false)).toEqual({ rows: [list[0]], folded: 4 })
    expect(foldGone(list, true).rows).toHaveLength(5)
    expect(foldGone([agent({}), ...gone(3)], false).folded).toBe(0)
  })
})
