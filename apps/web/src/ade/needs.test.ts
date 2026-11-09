import type { ItemDoc, RawDoc, TaskDoc } from '@hh/shared'
import { describe, expect, it } from 'vitest'
import { justIn, needsYou } from './needs'

const task = (id: string, status: TaskDoc['status'], at: string): TaskDoc => ({
  team_id: 'hh', id, title: id, side: 'frontend', owner: 'jam', paths: [], status, proposed_by: 'jam', created_at: at, updated_at: at,
})
const item = (id: string, kind: ItemDoc['kind'], at: string, extra: Partial<ItemDoc> = {}): ItemDoc => ({
  team_id: 'hh', id, kind, text: id, who: 'cam', at, tags: [], raw_ids: [], status: 'open', ...extra,
})

describe('needs you', () => {
  it('puts work orders first, then unanswered decisions and todos, newest first', () => {
    const tasks = [task('t1', 'proposed', '2026-11-09T21:00:00Z'), task('t2', 'claimed', '2026-11-09T21:01:00Z')]
    const items = [
      item('old', 'decision', '2026-11-09T20:00:00Z'),
      item('new', 'todo', '2026-11-09T21:30:00Z'),
      item('fact', 'fact', '2026-11-09T21:40:00Z'),
      item('answered', 'decision', '2026-11-09T21:50:00Z', { verdict: 'confirmed' }),
    ]
    const n = needsYou(tasks, items, new Set())
    expect(n.orders.map((t) => t.id)).toEqual(['t1'])
    expect(n.asks.map((i) => i.id)).toEqual(['new', 'old'])
    expect(n.total).toBe(3)
  })
  it('drops what this phone already answered and caps the list', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id, i) => item(id, 'todo', `2026-11-09T21:0${i}:00Z`))
    const n = needsYou([], items, new Set(['e']), 3)
    expect(n.asks.map((i) => i.id)).toEqual(['d', 'c', 'b'])
  })
})

describe('just in', () => {
  it('skips task bookkeeping lines', () => {
    const doc = (id: string, ref?: string) => ({ id, source_ref: ref }) as RawDoc
    expect(justIn([doc('a', 'task:1'), doc('b'), doc('c')], 5).map((d) => d.id)).toEqual(['b', 'c'])
  })
})
