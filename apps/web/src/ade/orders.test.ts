import type { TaskDoc } from '@hh/shared'
import { describe, expect, it } from 'vitest'
import { putTaskIn } from './live'
import { acceptOutcome, isDismissed, orderFor, parsePaths, proposedOrders, workTasks } from './orders'

const task = (over: Partial<TaskDoc>): TaskDoc => ({
  team_id: 't1',
  id: 'w1',
  title: 'Make work orders obvious',
  side: 'frontend',
  owner: 'jam',
  paths: ['apps/web/src/ade/'],
  status: 'proposed',
  proposed_by: 'jam',
  created_at: '2026-11-09T19:00:00.000Z',
  updated_at: '2026-11-09T19:00:00.000Z',
  ...over,
})

describe('work order lists', () => {
  const list = [
    task({ id: 'p1' }),
    task({ id: 'p2', created_at: '2026-11-09T19:05:00.000Z' }),
    task({ id: 'gone', status: 'released' }),
    task({ id: 'took', status: 'claimed', owner: 'jake' }),
    task({ id: 'dropped', status: 'released', owner: 'jake' }),
    task({ id: 'direct', status: 'claimed', owner: 'agent:opus-1', proposed_by: undefined }),
  ]

  it('proposed orders come out newest first', () => {
    expect(proposedOrders(list).map((t) => t.id)).toEqual(['p2', 'p1'])
  })

  it('work leaves out proposed and dismissed orders but keeps accepted ones, even if later released', () => {
    expect(workTasks(list).map((t) => t.id)).toEqual(['took', 'direct', 'dropped'])
    expect(isDismissed(list[2] as TaskDoc)).toBe(true)
    expect(isDismissed(list[4] as TaskDoc)).toBe(false)
  })

  it('names the suggested owner, else the side', () => {
    expect(orderFor(task({ suggested_owner: 'jake' }))).toBe('jake')
    expect(orderFor(task({ suggested_owner: 'agent:opus-2' }))).toBe('opus-2')
    expect(orderFor(task({ side: 'backend' }))).toBe('backend side')
  })
})

describe('parsePaths', () => {
  it('splits on commas, spaces and new lines, drops ./ and duplicates', () => {
    expect(parsePaths(' ./apps/web/src/a.ts, apps/api/\napps/api/  ')).toEqual(['apps/web/src/a.ts', 'apps/api/'])
    expect(parsePaths('  ')).toEqual([])
  })
})

describe('acceptOutcome', () => {
  it('reads 200 as the claimed task', () => {
    const t = task({ status: 'claimed', owner: 'cam' })
    expect(acceptOutcome(200, t)).toEqual({ ok: true, task: t })
  })

  it('reads 409 as a conflict with the API text and the paths in the way', () => {
    const body = { error: 'apps/web/ is held by jake (Theme pass)', reason: 'overlap', offending_paths: ['apps/web/'], conflicts: [] }
    expect(acceptOutcome(409, body)).toEqual({ ok: false, kind: 'conflict', error: body.error, paths: ['apps/web/'] })
  })

  it('reads the "no paths yet" 400 as a request for paths, and other failures as errors', () => {
    expect(acceptOutcome(400, { error: 'this work order has no paths yet: pass the paths you will edit' }).ok).toBe(false)
    expect(acceptOutcome(400, { error: 'this work order has no paths yet: pass the paths you will edit' })).toMatchObject({ kind: 'paths' })
    expect(acceptOutcome(400, { error: 'task is already claimed' })).toMatchObject({ kind: 'error', error: 'task is already claimed' })
    expect(acceptOutcome(502, null)).toMatchObject({ kind: 'error', error: 'accept answered 502' })
  })
})

describe('putTaskIn', () => {
  it('replaces with the POST answer, but never with an older copy than the stream delivered', () => {
    const proposed = task({})
    const claimed = task({ status: 'claimed', owner: 'cam', updated_at: '2026-11-09T19:10:00.000Z' })
    expect(putTaskIn([proposed], claimed)).toEqual([claimed])
    const done = task({ status: 'done', owner: 'cam', updated_at: '2026-11-09T19:20:00.000Z' })
    expect(putTaskIn([done], claimed)).toEqual([done])
  })
})
