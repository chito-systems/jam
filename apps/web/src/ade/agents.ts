// Which agent is which: pure helpers over GET /api/agents (tested in agents.test.ts).
import type { AgentDoc } from '@hh/shared'
import type { MarkMode } from './Mark'

/** "cam-opus-1" working for "cam" → "opus-1". Without a matching human prefix the name stays whole. */
export function shortName(a: Pick<AgentDoc, 'name' | 'human'>): string {
  const prefix = a.human ? `${a.human}-` : ''
  return prefix && a.name.startsWith(prefix) && a.name.length > prefix.length ? a.name.slice(prefix.length) : a.name
}

/** How an owner reads in the workspace: "opus-1 · cam" when the agent is known, else "agent:" stripped. */
export function ownerLabel(who: string, known: ReadonlyMap<string, AgentDoc>): string {
  const a = known.get(who)
  if (a) return a.human ? `${shortName(a)} · ${a.human}` : a.name
  return who.startsWith('agent:') ? who.slice(6) : who
}

/** Working while it holds a claim, waiting when active with nothing claimed, otherwise still. */
export function agentMode(a: Pick<AgentDoc, 'state' | 'claims'>): MarkMode {
  if (a.state !== 'active') return a.state === 'idle' ? 'idle' : 'still'
  return a.claims.length ? 'working' : 'waiting'
}

export type PersonGroup = { human: string; count?: number; agents: AgentDoc[] }

/**
 * People from the brain counts (most first), each with the agents that work for them.
 * People seen only through their agents come after; agents with no human go in `unassigned`.
 * Agent entries in `byWho` that /api/agents knows are folded under their person; unknown ones stay as rows.
 */
export function groupAgents(byWho: Record<string, number>, agents: AgentDoc[]): { people: PersonGroup[]; unassigned: AgentDoc[]; others: [string, number][] } {
  const known = new Set(agents.map((a) => a.id))
  const counts = Object.entries(byWho).sort((a, b) => b[1] - a[1])
  const people: PersonGroup[] = counts.filter(([w]) => !w.startsWith('agent:')).map(([human, count]) => ({ human, count, agents: [] }))
  const others = counts.filter(([w]) => w.startsWith('agent:') && !known.has(w))
  const unassigned: AgentDoc[] = []
  for (const a of agents) {
    if (!a.human) {
      unassigned.push(a)
      continue
    }
    let g = people.find((p) => p.human === a.human)
    if (!g) {
      g = { human: a.human, agents: [] }
      people.push(g)
    }
    g.agents.push(a)
  }
  return { people, unassigned, others }
}

/** Gone agents fold away once there are more than this many in a group. */
export const GONE_FOLD = 3

/** The rows to show and how many gone agents are folded behind "N gone". */
export function foldGone(agents: AgentDoc[], open: boolean): { rows: AgentDoc[]; folded: number } {
  const gone = agents.filter((a) => a.state === 'gone').length
  if (open || gone <= GONE_FOLD) return { rows: agents, folded: 0 }
  return { rows: agents.filter((a) => a.state !== 'gone'), folded: gone }
}
