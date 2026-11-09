// The left rail's three sections: SHARED (team feed, jam), YOUR AGENTS, PEOPLE. Pure (rail.test.ts).
import type { AgentDoc, ItemDoc, TaskDoc } from '@hh/shared'
import type { Member } from './live'
import { agentName } from './live'

/** Items nobody has confirmed or rejected yet: jam is waiting on a person. */
export const needsHuman = (items: ItemDoc[]) => items.filter((i) => !i.verdict)

/** Work orders someone accepted: jam drafted them, a person or agent took them. Newest first. */
export const assignedOrders = (tasks: TaskDoc[]) =>
  tasks.filter((t) => t.proposed_by === 'jam' && (t.status === 'claimed' || t.status === 'done')).sort((a, b) => b.updated_at.localeCompare(a.updated_at))

/** Agents that work for me. */
export const myAgents = (agents: AgentDoc[], me: string) => agents.filter((a) => a.human?.toLowerCase() === me.toLowerCase())

/** Open terminal agents that have not shown up in /api/agents yet. */
export const unregistered = (names: string[], agents: AgentDoc[]) => {
  const known = new Set(agents.map((a) => agentName(a.id)))
  return names.filter((n) => !known.has(n))
}

/** People in the rail: humans only, and never jam (it is the shared agent above). */
export const railPeople = <T extends { human: string }>(people: T[]) => people.filter((p) => p.human.toLowerCase() !== 'jam')

/** What a person is on right now: their open claim, the work orders waiting for them, or idle. */
export function personNow(m: Pick<Member, 'working' | 'assigned'>): string {
  if (m.working.length === 1) return `on ${m.working[0]?.title}`
  if (m.working.length > 1) return `${m.working.length} claims open`
  const n = m.assigned.length
  if (n) return `${n} work ${n === 1 ? 'order' : 'orders'} waiting`
  return 'idle'
}
