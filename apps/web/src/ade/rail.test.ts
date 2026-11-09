import type { AgentDoc, ItemDoc, TaskDoc } from '@hh/shared'
import { describe, expect, it } from 'vitest'
import { assignedOrders, myAgents, needsHuman, personNow, railPeople, unregistered } from './rail'

const task = (o: Partial<TaskDoc>) => ({ id: 'x', title: 't', status: 'claimed', updated_at: '2026-11-09T10:00:00Z', ...o }) as TaskDoc
const agent = (id: string, human?: string) => ({ id, name: id.slice(6), human }) as AgentDoc

describe('rail', () => {
  it('needsHuman keeps items without a verdict', () => {
    const items = [{ id: 'a' }, { id: 'b', verdict: 'confirmed' }, { id: 'c', verdict: 'rejected' }] as ItemDoc[]
    expect(needsHuman(items).map((i) => i.id)).toEqual(['a'])
  })
  it('assignedOrders: jam drafted, someone took it', () => {
    const ts = [
      task({ id: '1', proposed_by: 'jam' }),
      task({ id: '2', proposed_by: 'jam', status: 'proposed' }),
      task({ id: '3' }),
      task({ id: '4', proposed_by: 'jam', status: 'done', updated_at: '2026-11-09T11:00:00Z' }),
    ]
    expect(assignedOrders(ts).map((t) => t.id)).toEqual(['4', '1'])
  })
  it('myAgents and unregistered terminals', () => {
    const as = [agent('agent:cam-opus-1', 'cam'), agent('agent:jake-sonnet-1', 'jake')]
    expect(myAgents(as, 'Cam').map((a) => a.id)).toEqual(['agent:cam-opus-1'])
    expect(unregistered(['cam-opus-1', 'cam-opus-2'], as)).toEqual(['cam-opus-2'])
  })
  it('people never include jam', () => {
    expect(railPeople([{ human: 'cam' }, { human: 'jam' }, { human: 'JAM' }])).toEqual([{ human: 'cam' }])
  })
  it('personNow: claim, waiting orders, or idle', () => {
    expect(personNow({ working: [task({ title: 'auth' })], assigned: [] })).toBe('on auth')
    expect(personNow({ working: [], assigned: [task({}), task({})] })).toBe('2 work orders waiting')
    expect(personNow({ working: [], assigned: [] })).toBe('idle')
  })
})
