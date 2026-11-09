import type { RawDoc, TaskDoc } from '@hh/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentName, ago, clock, formatMs, isAgent, loadIdentity, mergeNew, saveIdentity, sortTasks, threadFor, upsert } from './live'

const task = (over: Partial<TaskDoc>): TaskDoc => ({
  team_id: 't1',
  id: 'k1',
  title: 'Chunk audio before Whisper',
  side: 'backend',
  owner: 'agent:opus-1',
  paths: ['apps/worker/src/transcribe.ts'],
  status: 'claimed',
  created_at: '2026-11-09T19:00:00.000Z',
  updated_at: '2026-11-09T19:00:00.000Z',
  ...over,
})

const doc = (over: Partial<RawDoc>): RawDoc => ({
  team_id: 't1',
  id: 'c1:0',
  capture_id: 'c1',
  type: 'text',
  who: 'agent:opus-1',
  at: '2026-11-09T19:05:00.000Z',
  seq: 0,
  text: 'note',
  ...over,
})

describe('names', () => {
  it('strips the agent prefix and leaves humans alone', () => {
    expect(agentName('agent:opus-1')).toBe('opus-1')
    expect(agentName('cam')).toBe('cam')
    expect(isAgent('agent:fable')).toBe(true)
    expect(isAgent('jake')).toBe(false)
  })
})

describe('time', () => {
  it('shows venue time, not UTC', () => {
    expect(clock('2026-11-09T19:04:00.000Z')).toBe('12:04 PM')
  })

  it('compacts ages', () => {
    const now = new Date('2026-11-09T20:00:00.000Z').getTime()
    expect(ago('2026-11-09T19:59:50.000Z', now)).toBe('now')
    expect(ago('2026-11-09T19:56:00.000Z', now)).toBe('4m')
    expect(ago('2026-11-09T18:00:00.000Z', now)).toBe('2h')
    expect(ago('2026-11-09T20:05:00.000Z', now)).toBe('now')
  })

  it('formats the searchable SLO number', () => {
    expect(formatMs(undefined)).toBe('n/a')
    expect(formatMs(140)).toBe('140 ms')
    expect(formatMs(3840)).toBe('3.8 s')
  })
})

describe('sortTasks', () => {
  it('puts open claims first, newest change first', () => {
    const out = sortTasks([
      task({ id: 'done-new', status: 'done', updated_at: '2026-11-09T19:30:00.000Z' }),
      task({ id: 'open-old', updated_at: '2026-11-09T19:01:00.000Z' }),
      task({ id: 'open-new', updated_at: '2026-11-09T19:20:00.000Z' }),
    ])
    expect(out.map((t) => t.id)).toEqual(['open-new', 'open-old', 'done-new'])
  })
})

describe('threadFor', () => {
  it('keeps the task notes and the owner’s writes during the claim, oldest first', () => {
    const t = task({ status: 'done', updated_at: '2026-11-09T19:30:00.000Z' })
    const out = threadFor(t, [
      doc({ id: 'close', source_ref: 'task:k1', who: 'cam', at: '2026-11-09T19:30:00.000Z' }),
      doc({ id: 'during', at: '2026-11-09T19:10:00.000Z' }),
      doc({ id: 'claim', source_ref: 'task:k1', at: '2026-11-09T19:00:00.000Z' }),
      doc({ id: 'before', at: '2026-11-09T18:00:00.000Z' }),
      doc({ id: 'after', at: '2026-11-09T19:45:00.000Z' }),
      doc({ id: 'other-agent', who: 'agent:fable', at: '2026-11-09T19:10:00.000Z' }),
      doc({ id: 'other-task', source_ref: 'task:k2', at: '2026-11-09T19:12:00.000Z' }),
    ])
    expect(out.map((d) => d.id)).toEqual(['claim', 'during', 'close'])
  })

  it('has no upper bound while the claim is open', () => {
    const out = threadFor(task({}), [doc({ id: 'late', at: '2026-11-09T23:00:00.000Z' })])
    expect(out.map((d) => d.id)).toEqual(['late'])
  })
})

describe('upsert', () => {
  it('replaces by id and keeps newest first', () => {
    const list = [doc({ id: 'a', at: '2026-11-09T19:00:00.000Z' })]
    const next = upsert(list, doc({ id: 'b', at: '2026-11-09T19:10:00.000Z' }), (d) => d.at)
    expect(next.map((d) => d.id)).toEqual(['b', 'a'])
    const again = upsert(next, doc({ id: 'a', at: '2026-11-09T19:20:00.000Z', text: 'new' }), (d) => d.at)
    expect(again.map((d) => d.id)).toEqual(['a', 'b'])
    expect(again[0]?.text).toBe('new')
  })
})

describe('mergeNew', () => {
  it('keeps what the stream already delivered and adds only unseen rows', () => {
    const live = [doc({ id: 'live', at: '2026-11-09T19:30:00.000Z', text: 'from the stream' })]
    const loaded = [doc({ id: 'live', at: '2026-11-09T19:30:00.000Z', text: 'stale copy' }), doc({ id: 'old', at: '2026-11-09T19:00:00.000Z' })]
    const out = mergeNew(live, loaded, (d) => d.at)
    expect(out.map((d) => d.id)).toEqual(['live', 'old'])
    expect(out[0]?.text).toBe('from the stream')
  })
})

describe('identity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('saves trimmed, lowercased values under the keys /c uses and reads them back', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    expect(saveIdentity(' Bog ', ' Jake')).toEqual({ team: 'bog', who: 'jake', persisted: true })
    expect(store.get('hh.team')).toBe('bog')
    expect(loadIdentity()).toEqual({ team: 'bog', who: 'jake', persisted: true })
  })

  it('says so, and logs once, when the browser refuses storage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(saveIdentity('bog', 'jake')).toEqual({ team: 'bog', who: 'jake', persisted: false })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
