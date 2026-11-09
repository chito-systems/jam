// The live data layer: everything the ADE shows on main comes from the API through here.
// Types only from @hh/shared: a value import would pull the Elasticsearch client into the bundle.
import type {
  AgentDoc,
  AgentsResponse,
  CaptureStatus,
  ChaosState,
  IngestResponse,
  ItemDoc,
  ItemsResponse,
  ItemVerdict,
  OwnershipMapResponse,
  RawDoc,
  RecentResponse,
  SearchResponse,
  Side,
  StatsResponse,
  TaskDoc,
  TasksResponse,
} from '@hh/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

const VENUE_TZ = 'America/Denver'
export const AGENTS_EVERY_MS = 10_000

// ---------- pure helpers (tested in live.test.ts) ----------

/** "agent:opus-1" → "opus-1". Humans pass through. */
export const agentName = (who: string) => (who.startsWith('agent:') ? who.slice(6) : who)
export const isAgent = (who: string) => who.startsWith('agent:')

/** Wall-clock time at the venue, e.g. "1:42 PM". */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: VENUE_TZ })
}

/** Compact age: "now", "4m", "2h", "3d". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** Open claims first, then finished work; newest change first within each. */
export function sortTasks(tasks: TaskDoc[]): TaskDoc[] {
  const rank = (t: TaskDoc) => (t.status === 'claimed' ? 0 : 1)
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at))
}

/**
 * What the brain holds about one task, oldest first: the claim and close notes the API
 * writes (source_ref "task:<id>") plus everything the owner added while holding the claim.
 */
export function threadFor(task: TaskDoc, docs: RawDoc[]): RawDoc[] {
  const end = task.status === 'claimed' ? undefined : task.updated_at
  return docs
    .filter(
      (d) =>
        d.source_ref === `task:${task.id}` ||
        (d.who === task.owner && !d.source_ref?.startsWith('task:') && d.at >= task.created_at && (!end || d.at <= end)),
    )
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
}

/** Insert or replace by id, keeping the list newest first by `key`. */
export function upsert<T extends { id: string }>(list: T[], doc: T, key: (d: T) => string, max = 300): T[] {
  const next = [doc, ...list.filter((d) => d.id !== doc.id)]
  return next.sort((a, b) => key(b).localeCompare(key(a))).slice(0, max)
}

/**
 * Merges a baseline load into what the stream already delivered, newest first by `key`.
 * A row we already hold is kept unless `newer(loaded, held)` says the loaded copy is newer
 * (catch-up after a dropped stream: a task that went claimed -> done while the laptop slept).
 */
export function mergeNew<T extends { id: string }>(
  have: T[],
  loaded: T[],
  key: (d: T) => string,
  newer: (a: T, b: T) => boolean = () => false,
  max = 300,
): T[] {
  const fresh = new Map(loaded.map((d) => [d.id, d]))
  const kept = have.map((d) => {
    const l = fresh.get(d.id)
    if (!l) return d
    fresh.delete(d.id)
    return newer(l, d) ? l : d
  })
  return [...kept, ...fresh.values()].sort((a, b) => key(b).localeCompare(key(a))).slice(0, max)
}

/** Insert or replace a task, unless the copy we hold is already newer (the SSE event can land first). */
export function putTaskIn(list: TaskDoc[], t: TaskDoc): TaskDoc[] {
  const held = list.find((x) => x.id === t.id)
  if (held && taskNewer(held, t)) return list
  return upsert(list, t, (x) => x.created_at)
}

/** True when `a` is a later version of the same task than `b`. */
export const taskNewer = (a: TaskDoc, b: TaskDoc) => a.updated_at > b.updated_at
/** True when `a` carries a later verdict than `b` (items change only when someone grades them). */
export const itemNewer = (a: ItemDoc, b: ItemDoc) => (a.verified_at ?? '') > (b.verified_at ?? '')

/** The librarian's own 0..1 confidence as a whole percentage, e.g. 0.874 -> "87%". */
export const pct = (n: number) => `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`

/** How long a failed capture stays under the feed. The Captures tab keeps it. */
export const FAILED_TTL_MS = 2 * 60_000

/** Captures still on their way, plus failures from the last two minutes. */
export function pendingCaptures(captures: CaptureStatus[], now: number): CaptureStatus[] {
  return captures.filter(
    (c) => c.state !== 'indexed' && (c.state !== 'failed' || now - new Date(c.received_at).getTime() < FAILED_TTL_MS),
  )
}

/** Tasks that were in `prev` and not done, and are done in `next`. Unknown tasks never count. */
export function newlyDone(prev: TaskDoc[], next: TaskDoc[]): TaskDoc[] {
  const was = new Map(prev.map((t) => [t.id, t.status]))
  return next.filter((t) => t.status === 'done' && was.has(t.id) && was.get(t.id) !== 'done')
}

// ---------- people ----------

/** side -> captain, from GET /api/ownership (the server's JAM_ROSTER). */
export type Captains = Partial<Record<Side, string>>

export function captainsOf(own: OwnershipMapResponse | undefined): Captains {
  const out: Captains = {}
  for (const s of own?.sides ?? []) if (s.captain) out[s.side] = s.captain
  return out
}

/** Work orders name people without the agent prefix and in lower case. */
export const sameWho = (a: string, b: string) => agentName(a).toLowerCase() === agentName(b).toLowerCase()

export type Member = {
  who: string
  /** For an agent: its presence from GET /api/agents (state, last tool, who it works for). */
  agent?: AgentDoc
  /** For a person: the agents that work for them. */
  agents: AgentDoc[]
  /** Claimed now: the files they are editing. */
  working: TaskDoc[]
  /** Proposed work orders jam suggested for them, waiting to be accepted. */
  assigned: TaskDoc[]
  finished: TaskDoc[]
  /** Their side: the roster's word for a captain, otherwise read from their tasks and captures. */
  side?: Side
  /** The side they captain, per the server roster. */
  captain?: Side
  /** Paths they hold across open claims. */
  holding: string[]
  said: RawDoc[]
  inBrain: number
}

export function member(who: string, tasks: TaskDoc[], docs: RawDoc[], inBrain = 0, captains: Captains = {}, agents: AgentDoc[] = []): Member {
  const helpers = isAgent(who) ? [] : agents.filter((a) => !!a.human && sameWho(a.human, who))
  // A person's work includes what their agents claimed for them.
  const by = new Set([who, ...helpers.map((a) => a.id)])
  const mine = sortTasks(tasks.filter((t) => t.status !== 'proposed' && by.has(t.owner)))
  const working = mine.filter((t) => t.status === 'claimed')
  // Work orders and captaincy belong to people, never to an agent that shares their name (agent:jake).
  const person = !isAgent(who)
  const assigned = person ? tasks.filter((t) => t.status === 'proposed' && !!t.suggested_owner && sameWho(t.suggested_owner, who)) : []
  const said = docs.filter((d) => d.who === who && !d.source_ref?.startsWith('task:'))
  // Open claims count most, then work jam's roster routed to them, then finished work, then
  // which half of the team their captures came from.
  const votes: Record<Side, number> = { backend: 0, frontend: 0 }
  for (const t of working) votes[t.side] += 3
  for (const t of assigned) votes[t.side] += 2
  for (const t of mine) votes[t.side] += 1
  for (const d of said) if (d.side) votes[d.side] += 0.5
  const captain = person ? (Object.keys(captains) as Side[]).find((k) => sameWho(captains[k] ?? '', who)) : undefined
  const guess = votes.backend || votes.frontend ? (votes.backend >= votes.frontend ? 'backend' : 'frontend') : undefined
  const side = captain ?? guess
  return {
    who,
    agent: agents.find((a) => a.id === who),
    agents: helpers,
    working,
    assigned,
    finished: mine.filter((t) => t.status === 'done'),
    side,
    captain,
    holding: [...new Set(working.flatMap((t) => t.paths))],
    said,
    inBrain,
  }
}

/**
 * Everyone the team has heard from or handed work to: brain authors, claim owners, side captains
 * and people jam suggested work orders for. Busiest first. jam itself only drafts, so it is left out.
 */
export function roster(byWho: Record<string, number>, tasks: TaskDoc[], docs: RawDoc[], captains: Captains = {}, agents: AgentDoc[] = []): Member[] {
  const names = new Set(Object.keys(byWho))
  const addName = (n: string) => ![...names].some((x) => !isAgent(x) && sameWho(x, n)) && names.add(n)
  for (const t of tasks) {
    if (t.status !== 'proposed') names.add(t.owner)
    else if (t.suggested_owner) addName(t.suggested_owner)
  }
  for (const c of Object.values(captains)) if (c) addName(c)
  for (const a of agents) {
    if (a.state !== 'gone') names.add(a.id)
    if (a.human) addName(a.human)
  }
  names.delete('jam')
  const score = (m: Member) => m.working.length * 1000 + m.assigned.length * 100 + m.inBrain
  return [...names]
    .map((who) => member(who, tasks, docs, byWho[who] ?? 0, captains, agents))
    .sort((a, b) => score(b) - score(a) || a.who.localeCompare(b.who))
}

/**
 * Someone's entries, newest first: what the stream delivered plus their own /api/recent page,
 * each once. Claim and close notes (source_ref "task:…") are the API's, not theirs.
 */
export function mergeSaid(stream: RawDoc[], loaded: RawDoc[]): RawDoc[] {
  const seen = new Set(stream.map((d) => d.id))
  const extra = loaded.filter((d) => !seen.has(d.id) && !d.source_ref?.startsWith('task:'))
  return [...stream, ...extra].sort((a, b) => b.at.localeCompare(a.at))
}

/** One line for the people list: what they are doing right now. */
export function memberLine(m: Member): string {
  if (m.working.length === 1) return `on ${m.working[0]?.title}`
  if (m.working.length > 1) return `${m.working.length} tasks open`
  if (m.assigned.length) return `${m.assigned.length} assigned`
  const live = m.agents.filter((a) => a.state === 'active').length
  if (live) return `${live} ${live === 1 ? 'agent' : 'agents'} active`
  if (m.agent) return m.agent.last_tool ? `${m.agent.state} · last ${m.agent.last_tool}` : m.agent.state
  return m.inBrain ? `${m.inBrain} in brain` : 'quiet'
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return 'n/a'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

// ---------- identity (same localStorage keys as the /c capture page) ----------

/** `persisted: false` means the browser refused storage: the identity lasts for this tab only. */
export type Identity = { team: string; who: string; persisted: boolean }

const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch (e) {
    console.warn(`reading ${key} from localStorage failed; asking for team and name again`, e)
    return ''
  }
}

export function loadIdentity(): Identity | null {
  const team = read('hh.team')
  const who = read('hh.who')
  return team && who ? { team, who, persisted: true } : null
}

export function saveIdentity(team: string, who: string): Identity {
  const id = { team: team.trim().toLowerCase(), who: who.trim().toLowerCase() }
  try {
    localStorage.setItem('hh.team', id.team)
    localStorage.setItem('hh.who', id.who)
    return { ...id, persisted: true }
  } catch (e) {
    // Private mode or blocked storage: works for this tab, and /c will ask again.
    console.warn('saving team and name to localStorage failed; the capture page will not share them', e)
    return { ...id, persisted: false }
  }
}

// ---------- http ----------

async function getJson<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  const res = await fetch(`${path}?${qs}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${path} answered ${res.status}`)
  }
  return (await res.json()) as T
}

export function searchBrain(team: string, q: string): Promise<SearchResponse> {
  return getJson<SearchResponse>('/api/search', { team_id: team, q, limit: 20 })
}

/** The team's coding agents: presence, who each works for, last tool. There is no SSE event for it, so poll. */
export function loadAgents(team: string): Promise<AgentsResponse> {
  return getJson<AgentsResponse>('/api/agents', { team_id: team })
}

/** Which side owns which paths, and each side's captain. */
export function loadOwnership(team: string): Promise<OwnershipMapResponse> {
  return getJson<OwnershipMapResponse>('/api/ownership', { team_id: team })
}

/** One person's own recent entries, so someone quiet lately still shows what they said. */
export function loadRecent(team: string, who: string): Promise<RecentResponse> {
  return getJson<RecentResponse>('/api/recent', { team_id: team, who, limit: 20 })
}

/** The GitHub activity the API ingested: PR events and Gitar reviews, for the Ship view. */
export function loadGithub(team: string, type: 'pr' | 'review'): Promise<RecentResponse> {
  return getJson<RecentResponse>('/api/recent', { team_id: team, type, limit: 200 })
}

export async function addNote(id: Identity, text: string): Promise<IngestResponse> {
  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team_id: id.team, who: id.who, type: 'text', text }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `ingest answered ${res.status}`)
  }
  return (await res.json()) as IngestResponse
}

/** POST /api/items/:id/verdict: a person confirms or rejects what the librarian extracted. */
export async function setVerdict(id: Identity, itemId: string, verdict: ItemVerdict): Promise<ItemDoc> {
  const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ team_id: id.team, who: id.who, verdict }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `verdict answered ${res.status}`)
  }
  return (await res.json()) as ItemDoc
}

/** The decision log as markdown, every entry quoting the words it came from, plus open todos and questions. */
export const decisionLogUrl = (team: string) => `/api/decisions.md?team_id=${encodeURIComponent(team)}&kinds=todo,question`

// ---------- the live store ----------

export type Live = {
  status: 'loading' | 'ready' | 'error'
  error?: string
  /** The event stream: live, or reconnecting after a drop. */
  conn: 'connecting' | 'live' | 'reconnecting'
  tasks: TaskDoc[]
  items: ItemDoc[]
  docs: RawDoc[]
  captures: CaptureStatus[]
  stats?: StatsResponse
  /** Every coding agent seen on the team, from GET /api/agents. A failed refresh keeps the last list. */
  agents: AgentDoc[]
  reload: () => void
  /** Puts a task we got back from a POST, so the page moves before the SSE event lands. */
  putTask: (t: TaskDoc) => void
  /** Same for the chaos switch. */
  putChaos: (c: ChaosState) => void
}

/** Loads the team's tasks, brain and stats, then keeps them current from the SSE feed. */
export function useLive(team: string | undefined): Live {
  const [status, setStatus] = useState<Live['status']>('loading')
  const [error, setError] = useState<string>()
  const [conn, setConn] = useState<Live['conn']>('connecting')
  const [tasks, setTasks] = useState<TaskDoc[]>([])
  const [items, setItems] = useState<ItemDoc[]>([])
  const [docs, setDocs] = useState<RawDoc[]>([])
  const [captures, setCaptures] = useState<CaptureStatus[]>([])
  const [stats, setStats] = useState<StatsResponse>()
  const [agents, setAgents] = useState<AgentDoc[]>([])
  const [attempt, setAttempt] = useState(0)
  const statsTimer = useRef(0)
  const statusRef = useRef(status)
  statusRef.current = status
  // A person pressed "Try again": show the loading state. Automatic retries stay silent.
  const manual = useRef(false)

  const putTask = useCallback((t: TaskDoc) => setTasks((list) => putTaskIn(list, t)), [])
  const putChaos = useCallback((c: ChaosState) => setStats((s) => (s ? { ...s, chaos: c.enabled } : s)), [])

  const reload = useCallback(() => {
    manual.current = true
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!team) return
    let dead = false
    let dropped = false
    let retry = 0

    const loadStats = () =>
      getJson<StatsResponse>('/api/stats', { team_id: team })
        .then((s) => !dead && setStats(s))
        .catch((e: unknown) => console.error('stats refresh failed', e))

    // Presence moves without feed events (an agent going idle), so poll it; a failure keeps the last list.
    const loadAgents = () =>
      getJson<AgentsResponse>('/api/agents', { team_id: team })
        .then((a) => !dead && setAgents(a.agents))
        .catch((e: unknown) => console.error('agents refresh failed', e))
    loadAgents()
    const agentsTimer = window.setInterval(loadAgents, AGENTS_EVERY_MS)

    // Merges into what the stream already delivered, so an event that lands mid-load is kept.
    const loadBaseline = (silent: boolean) => {
      if (!silent) {
        setStatus('loading')
        setError(undefined)
      }
      Promise.all([
        getJson<TasksResponse>('/api/tasks', { team_id: team, limit: 100 }),
        getJson<ItemsResponse>('/api/items', { team_id: team, limit: 100 }),
        getJson<RecentResponse>('/api/recent', { team_id: team, limit: 200 }),
        getJson<StatsResponse>('/api/stats', { team_id: team }),
      ])
        .then(([t, i, r, s]) => {
          if (dead) return
          setTasks((list) => mergeNew(list, t.tasks, (x) => x.created_at, taskNewer))
          setItems((list) => mergeNew(list, i.items, (x) => x.at, itemNewer))
          setDocs((list) => mergeNew(list, r.docs, (x) => x.at))
          setStats(s)
          setError(undefined)
          setStatus('ready')
        })
        .catch((e: unknown) => {
          if (dead) return
          console.error('loading the workspace failed', e)
          if (silent) return
          setError(e instanceof Error ? e.message : 'The API did not answer.')
          setStatus('error')
        })
    }
    // Retries after a closed stream are silent: an error card stays put and clears itself on success.
    loadBaseline(attempt > 0 && !manual.current && statusRef.current !== 'loading')
    manual.current = false

    // The stream has no snapshot and no replay: the GETs above are the baseline.
    const es = new EventSource(`/api/events?team_id=${encodeURIComponent(team)}`)
    const on = <T>(name: string, fn: (data: T) => void) =>
      es.addEventListener(name, (ev) => {
        try {
          fn(JSON.parse((ev as MessageEvent<string>).data) as T)
        } catch (e) {
          console.error(`bad ${name} event from /api/events`, e)
        }
      })
    const statsSoon = () => {
      window.clearTimeout(statsTimer.current)
      statsTimer.current = window.setTimeout(loadStats, 800)
    }
    es.onopen = () => {
      setConn('live')
      // Nothing is replayed after a drop, so catch up from the API.
      if (dropped) loadBaseline(true)
      dropped = false
    }
    es.onerror = () => {
      setConn('reconnecting')
      dropped = true
      // The browser retries on its own unless the stream was closed for good (a 502 during a deploy).
      if (es.readyState === EventSource.CLOSED) retry = window.setTimeout(() => !dead && setAttempt((n) => n + 1), 3000)
    }
    on<RawDoc>('raw', (d) => {
      setDocs((list) => upsert(list, d, (x) => x.at))
      statsSoon()
    })
    on<ItemDoc>('item', (d) => {
      setItems((list) => upsert(list, d, (x) => x.at))
      statsSoon()
    })
    on<ChaosState>('chaos', putChaos)
    on<TaskDoc>('task', (d) => {
      setTasks((list) => upsert(list, d, (x) => x.created_at))
      statsSoon()
      loadAgents()
    })
    on<CaptureStatus>('capture', (c) => {
      setCaptures((list) => [c, ...list.filter((x) => x.capture_id !== c.capture_id)].slice(0, 50))
      if (c.state === 'indexed' || c.state === 'failed') statsSoon()
    })

    return () => {
      dead = true
      es.close()
      window.clearTimeout(retry)
      window.clearInterval(agentsTimer)
      window.clearTimeout(statsTimer.current)
    }
  }, [team, attempt, putChaos])

  return { status, error, conn, tasks, items, docs, captures, stats, agents, reload, putTask, putChaos }
}
