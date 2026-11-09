// Which coding agents are on the team right now. In memory on purpose: presence is cheap, recent and disposable.
import type { RosterEntry } from "./assign";
import type { AgentDoc, AgentState, Side, TaskDoc } from "./types";

export interface PresenceEntry {
  team_id: string;
  who: string; // "cam-opus-1", without the "agent:" prefix
  side?: Side;
  first_seen: string;
  last_seen: string;
  last_tool?: string;
  calls: number;
}

export interface Presence {
  seen(input: { team_id: string; who: string; side?: Side; tool?: string }): void;
  /** Most recently seen first. */
  list(team_id: string): PresenceEntry[];
}

export const MAX_AGENTS_PER_TEAM = 200;
const ACTIVE_MS = 2 * 60_000;
const IDLE_MS = 15 * 60_000;

export function createPresence(opts: { now?: () => Date } = {}): Presence {
  const now = opts.now ?? (() => new Date());
  const teams = new Map<string, Map<string, PresenceEntry>>();
  return {
    seen({ team_id, who, side, tool }) {
      const at = now().toISOString();
      const team = teams.get(team_id) ?? new Map<string, PresenceEntry>();
      teams.set(team_id, team);
      const prev = team.get(who);
      const entry: PresenceEntry = prev ?? { team_id, who, first_seen: at, last_seen: at, calls: 0 };
      entry.last_seen = at;
      if (side) entry.side = side;
      if (tool) {
        entry.last_tool = tool;
        entry.calls += 1;
      }
      team.set(who, entry);
      if (team.size > MAX_AGENTS_PER_TEAM) {
        const oldest = [...team.values()].reduce((a, b) => (b.last_seen < a.last_seen ? b : a));
        team.delete(oldest.who);
      }
    },
    list(team_id) {
      return [...(teams.get(team_id)?.values() ?? [])]
        .map((e) => ({ ...e }))
        .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
    },
  };
}

/** "cam-opus-1" -> "cam": the longest roster name that `who` equals or starts with followed by "-". */
export function humanOf(who: string, roster: RosterEntry[]): string | undefined {
  const name = who.replace(/^agent:/, "").toLowerCase();
  return roster
    .map((e) => e.name)
    .filter((n) => name === n || name.startsWith(`${n}-`))
    .sort((a, b) => b.length - a.length)[0];
}

export function agentState(last_seen: string, now: Date): AgentState {
  const age = now.getTime() - Date.parse(last_seen);
  if (age < ACTIVE_MS) return "active";
  if (age < IDLE_MS) return "idle";
  return "gone";
}

export function toAgentDoc(
  entry: PresenceEntry,
  { roster, claims, now }: { roster: RosterEntry[]; claims: TaskDoc[]; now: Date },
): AgentDoc {
  const id = `agent:${entry.who}`;
  const human = humanOf(entry.who, roster);
  return {
    team_id: entry.team_id,
    id,
    name: entry.who,
    ...(human ? { human } : {}),
    ...(entry.side ? { side: entry.side } : {}),
    state: agentState(entry.last_seen, now),
    first_seen: entry.first_seen,
    last_seen: entry.last_seen,
    ...(entry.last_tool ? { last_tool: entry.last_tool } : {}),
    calls: entry.calls,
    claims: claims.filter((t) => t.status === "claimed" && t.owner === id),
  };
}

const STATE_ORDER: Record<AgentState, number> = { active: 0, idle: 1, gone: 2 };

/** Active, then idle, then gone; most recently seen first within each. */
export const sortAgents = (agents: AgentDoc[]) =>
  [...agents].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.last_seen.localeCompare(a.last_seen));
