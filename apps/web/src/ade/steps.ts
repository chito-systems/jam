// The setup guide's logic, kept pure so it runs in tests without a browser.
import type { Side, StatsResponse } from '@hh/shared'
import type { Identity } from './live'

/** localStorage key: set once the guide has been dismissed on this browser. */
export const GUIDE_KEY = 'jam-guide'
/** The local terminal bridge (pnpm --filter @hh/web bridge). */
export const BRIDGE_HEALTH = 'http://127.0.0.1:4317/health'
export const BRIDGE_COMMAND = 'pnpm --filter @hh/web bridge'

export type Mic = 'granted' | 'denied' | 'prompt' | 'unknown'
export type Bridge = 'checking' | 'running' | 'not running'
export type StepId = 'in' | 'install' | 'mic' | 'say' | 'agent' | 'terminal'
export const STEPS: StepId[] = ['in', 'install', 'mic', 'say', 'agent', 'terminal']

/** On a phone: who you are, the mic, one thing said, and (in a browser, not the app) the home screen.
 *  Agents and the terminal live on a laptop, so they are not phone steps. */
export function phoneSteps(inApp: boolean): StepId[] {
  return inApp ? ['in', 'mic', 'say'] : ['in', 'mic', 'say', 'install']
}

export type Signals = {
  identity: Identity
  standalone: boolean
  mic: Mic
  docs: { who: string }[]
  stats?: Pick<StatsResponse, 'by_who'>
  bridge: Bridge
}

/** How many agents the brain has heard from (stats keys like "agent:opus-1"). */
export function agentCount(stats: Signals['stats']): number {
  return Object.keys(stats?.by_who ?? {}).filter((w) => w.startsWith('agent:')).length
}

/** Done or not for each step, from live signals only. */
export function stepStatus(s: Signals): Record<StepId, boolean> {
  return {
    in: Boolean(s.identity.team && s.identity.who),
    install: s.standalone,
    mic: s.mic === 'granted',
    // by_who covers the whole brain; docs only the most recent entries.
    say: (s.stats?.by_who[s.identity.who] ?? 0) > 0 || s.docs.some((d) => d.who === s.identity.who),
    // Your own agent, under the name the command below gives it. A teammate's does not count.
    agent: (s.stats?.by_who[`agent:${agentWho(s.identity.who)}`] ?? 0) > 0,
    terminal: s.bridge === 'running',
  }
}

/** "3 of 6 set up" */
export function setupLine(status: Record<StepId, boolean>, steps: StepId[] = STEPS): string {
  return `${steps.filter((id) => status[id]).length} of ${steps.length} set up`
}

/** The MCP server takes who up to 56 characters; leave room for "-agent". */
const WHO_MAX = 56
const SUFFIX = '-agent'

/** The name this person's agent connects as: "jake-agent". */
export const agentWho = (who: string) => `${who.slice(0, WHO_MAX - SUFFIX.length)}${SUFFIX}`

/** The one-line `claude mcp add` for this page's API, team and person. */
export function mcpCommand(origin: string, id: Pick<Identity, 'team' | 'who'>, side: Side): string {
  const who = agentWho(id.who)
  const qs = new URLSearchParams({ team_id: id.team, who, side })
  const url = `${origin.replace(/\/+$/, '')}/mcp?${qs}`
  return `claude mcp add hack-harness-context --scope user --transport http "${url}"`
}
