import type { CaptureStatus, ItemDoc, RawDoc, TaskDoc } from '@hh/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentName, ago, captainsOf, clock, decisionLogUrl, formatMs, isAgent, itemNewer, loadIdentity, type Member, member, memberLine, mergeNew, mergeSaid, newlyDone, pct, pendingCaptures, roster, saveIdentity, sortTasks, taskNewer, threadFor, upsert } from './live'

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

const item = (over: Partial<ItemDoc>): ItemDoc => ({
  team_id: 't1',
  id: 'i1',
  kind: 'decision',
  text: 'Use Elastic for the brain',
  who: 'agent:librarian',
  at: '2026-11-09T19:05:00.000Z',
  tags: [],
  raw_ids: ['c1:0'],
  status: 'open',
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

  it('replaces a held task when the loaded copy changed later (claimed -> done while the stream was down)', () => {
    const held = [task({ id: 'k1', status: 'claimed' }), task({ id: 'k2', created_at: '2026-11-09T19:10:00.000Z' })]
    const loaded = [task({ id: 'k1', status: 'done', updated_at: '2026-11-09T19:40:00.000Z' }), task({ id: 'k3', created_at: '2026-11-09T18:00:00.000Z' })]
    const out = mergeNew(held, loaded, (t) => t.created_at, taskNewer)
    expect(out.map((t) => t.id)).toEqual(['k2', 'k1', 'k3'])
    expect(out.find((t) => t.id === 'k1')?.status).toBe('done')
  })

  it('keeps the held task when the loaded copy is the same age or older', () => {
    const held = [task({ id: 'k1', status: 'done', updated_at: '2026-11-09T19:40:00.000Z' })]
    const stale = [task({ id: 'k1', status: 'claimed', updated_at: '2026-11-09T19:00:00.000Z' })]
    expect(mergeNew(held, stale, (t) => t.created_at, taskNewer)[0]?.status).toBe('done')
    const same = [task({ id: 'k1', status: 'claimed', updated_at: '2026-11-09T19:40:00.000Z' })]
    expect(mergeNew(held, same, (t) => t.created_at, taskNewer)[0]?.status).toBe('done')
  })

  it('takes a loaded item that was graded since we last saw it, and never un-grades one', () => {
    const plain = item({})
    const graded = item({ verdict: 'confirmed', verified_by: 'jake', verified_at: '2026-11-09T20:00:00.000Z' })
    expect(mergeNew([plain], [graded], (i) => i.at, itemNewer)[0]?.verdict).toBe('confirmed')
    expect(mergeNew([graded], [plain], (i) => i.at, itemNewer)[0]?.verdict).toBe('confirmed')
  })

  it('still caps the list', () => {
    const loaded = [doc({ id: 'a', at: '2026-11-09T19:03:00.000Z' }), doc({ id: 'b', at: '2026-11-09T19:02:00.000Z' }), doc({ id: 'c', at: '2026-11-09T19:01:00.000Z' })]
    expect(mergeNew([], loaded, (d) => d.at, undefined, 2).map((d) => d.id)).toEqual(['a', 'b'])
  })
})

describe('grading and links', () => {
  it('shows confidence as a clamped whole percentage', () => {
    expect(pct(0.874)).toBe('87%')
    expect(pct(1)).toBe('100%')
    expect(pct(0)).toBe('0%')
    expect(pct(1.4)).toBe('100%')
  })

  it('escapes the team code in the decision log link', () => {
    expect(decisionLogUrl('cnh slc&x')).toBe('/api/decisions.md?team_id=cnh%20slc%26x&kinds=todo,question')
  })
})

describe('pendingCaptures', () => {
  const now = new Date('2026-11-09T20:00:00.000Z').getTime()
  const cap = (over: Partial<CaptureStatus>): CaptureStatus => ({
    capture_id: 'c1',
    team_id: 't1',
    who: 'jake',
    type: 'voice',
    state: 'queued',
    received_at: '2026-11-09T19:59:30.000Z',
    raw_ids: [],
    ...over,
  })

  it('keeps captures in flight and recent failures, drops searchable ones and failures older than two minutes', () => {
    const list = [
      cap({ capture_id: 'flight', state: 'indexing', received_at: '2026-11-09T19:00:00.000Z' }),
      cap({ capture_id: 'done', state: 'indexed' }),
      cap({ capture_id: 'fresh-fail', state: 'failed', received_at: '2026-11-09T19:58:30.000Z' }),
      cap({ capture_id: 'old-fail', state: 'failed', received_at: '2026-11-09T19:57:59.000Z' }),
    ]
    expect(pendingCaptures(list, now).map((c) => c.capture_id)).toEqual(['flight', 'fresh-fail'])
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

describe('newlyDone', () => {
  it('finds tasks the stream moved from claimed to done', () => {
    const prev = [task({ id: 'a' }), task({ id: 'b', status: 'done' }), task({ id: 'c' })]
    const next = [task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'done' }), task({ id: 'c', status: 'released' })]
    expect(newlyDone(prev, next).map((t) => t.id)).toEqual(['a'])
  })
  it('ignores tasks it has never seen, so a baseline load is silent', () => {
    expect(newlyDone([], [task({ id: 'a', status: 'done' })])).toEqual([])
  })
})

describe('people', () => {
  const tasks = [
    task({ id: 'w1', owner: 'cam', side: 'backend', status: 'claimed', paths: ['apps/api/src/a.ts'] }),
    task({ id: 'd1', owner: 'cam', side: 'backend', status: 'done' }),
    task({ id: 'p1', owner: 'jam', proposed_by: 'jam', side: 'frontend', status: 'proposed', suggested_owner: 'jake', paths: [] }),
    task({ id: 'w2', owner: 'agent:opus-1', side: 'frontend', status: 'claimed', paths: ['apps/web/src/x.tsx'] }),
  ]

  it('splits a person into working, assigned and finished, and reads their side from their claims', () => {
    const cam = member('cam', tasks, [doc({ who: 'cam', side: 'frontend' })])
    expect(cam.working.map((t) => t.id)).toEqual(['w1'])
    expect(cam.finished.map((t) => t.id)).toEqual(['d1'])
    expect(cam.assigned).toEqual([])
    expect(cam.side).toBe('backend')
    expect(cam.holding).toEqual(['apps/api/src/a.ts'])
    expect(cam.said).toHaveLength(1)
  })

  it('counts work orders jam suggested, and has no side without evidence', () => {
    const jake = member('Jake', tasks, [])
    expect(jake.assigned.map((t) => t.id)).toEqual(['p1'])
    expect(jake.working).toEqual([])
    expect(jake.side).toBe('frontend')
    expect(member('gitar', tasks, []).side).toBeUndefined()
  })

  it('counts a GitHub login as its person and leaves bots out', () => {
    const list = roster({ 'chito-systems': 5, cam: 1, quakeob: 2, gitar: 9, fable: 3 }, [], [])
    expect(list.map((m) => m.who).sort()).toEqual(['cam', 'jake'])
    expect(list.find((m) => m.who === 'cam')?.inBrain).toBe(6)
  })

  it('lists brain authors, claim owners and suggested owners, busiest first, without jam', () => {
    const list = roster({ gitar: 4, jake: 2 }, tasks, [])
    expect(list.map((m) => m.who)).toEqual(['agent:opus-1', 'cam', 'jake']) // gitar is a reviewer bot, not a teammate
    expect(memberLine(list[0] as Member)).toBe(`on ${tasks[3]?.title}`)
    expect(memberLine(list[2] as Member)).toBe('1 assigned')
    expect(memberLine(list[3] as Member)).toBe('4 in brain')
  })

  it('takes a captain\'s side from the roster and lists quiet captains', () => {
    const own = { sides: [{ side: 'frontend' as const, paths: ['apps/web/'], captain: 'cam', claims: [] }, { side: 'backend' as const, paths: [], claims: [] }] }
    const captains = captainsOf(own)
    expect(captains).toEqual({ frontend: 'cam' })
    const cam = member('cam', tasks, [], 0, captains)
    expect(cam.side).toBe('frontend')
    expect(cam.captain).toBe('frontend')
    expect(roster({}, [], [], { backend: 'Lee' }).map((m) => [m.who, m.captain])).toEqual([['Lee', 'backend']])
  })


  it('gives each person the agents /api/agents says work for them', () => {
    const agent = (id: string, human: string | undefined, state: 'active' | 'idle' | 'gone') => ({
      team_id: 't1', id, name: id.slice(6), human, state, first_seen: '2026-11-09T19:00:00.000Z', last_seen: '2026-11-09T19:00:00.000Z', calls: 3, claims: [],
    })
    const agents = [agent('agent:cam-opus-1', 'cam', 'active'), agent('agent:stray-1', undefined, 'idle'), agent('agent:cam-old', 'cam', 'gone')]
    const list = roster({ jake: 1 }, [], [], {}, agents)
    expect(list.map((m) => m.who).sort()).toEqual(['agent:cam-opus-1', 'agent:stray-1', 'cam', 'jake'])
    const cam = list.find((m) => m.who === 'cam') as Member
    expect(cam.agents.map((a) => a.id)).toEqual(['agent:cam-opus-1', 'agent:cam-old'])
    expect(memberLine(cam)).toBe('1 agent active')
    const busy = member('cam', [task({ id: 'a1', owner: 'agent:cam-opus-1', status: 'claimed', paths: ['apps/api/x.ts'] })], [], 0, {}, agents)
    expect(busy.working.map((t) => t.id)).toEqual(['a1'])
    expect(busy.holding).toEqual(['apps/api/x.ts'])
    expect(memberLine(list.find((m) => m.who === 'agent:stray-1') as Member)).toBe('idle')
  })

  it('keeps a person when their agent shares their name, and gives the agent no captaincy or work orders', () => {
    const agents = [{ team_id: 't1', id: 'agent:jake', name: 'jake', human: 'jake', state: 'active' as const, first_seen: '2026-11-09T19:00:00.000Z', last_seen: '2026-11-09T19:00:00.000Z', calls: 1, claims: [] }]
    const list = roster({}, tasks, [], { frontend: 'jake' }, agents)
    const jake = list.find((m) => m.who === 'jake') as Member
    const bot = list.find((m) => m.who === 'agent:jake') as Member
    expect(jake.captain).toBe('frontend')
    expect(jake.assigned.map((t) => t.id)).toEqual(['p1'])
    expect(bot.captain).toBeUndefined()
    expect(bot.assigned).toEqual([])
    expect(jake.agents.map((a) => a.id)).toEqual(['agent:jake'])
  })

  it('merges a person\'s own page into what the stream delivered, once each, newest first, without task notes', () => {
    const a = doc({ id: 'a', who: 'cam', at: '2026-11-09T19:01:00.000Z' })
    const b = doc({ id: 'b', who: 'cam', at: '2026-11-09T19:03:00.000Z' })
    const note = doc({ id: 'n', who: 'cam', at: '2026-11-09T19:04:00.000Z', source_ref: 'task:k1' })
    expect(mergeSaid([a], [b, a, note]).map((d) => d.id)).toEqual(['b', 'a'])
  })
})
