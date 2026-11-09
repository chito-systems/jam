// The live data layer: everything the ADE shows on main comes from the API through here.
// Types only from @hh/shared: a value import would pull the Elasticsearch client into the bundle.
import type {
  CaptureStatus,
  IngestResponse,
  ItemDoc,
  ItemsResponse,
  RawDoc,
  RecentResponse,
  SearchResponse,
  StatsResponse,
  TaskDoc,
  TasksResponse,
} from '@hh/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

const VENUE_TZ = 'America/Denver'

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

/** Baseline rows the stream has not already delivered, merged in newest first. */
export function mergeNew<T extends { id: string }>(have: T[], loaded: T[], key: (d: T) => string, max = 300): T[] {
  const seen = new Set(have.map((d) => d.id))
  return [...have, ...loaded.filter((d) => !seen.has(d.id))].sort((a, b) => key(b).localeCompare(key(a))).slice(0, max)
}

/** Tasks that were in `prev` and not done, and are done in `next`. Unknown tasks never count. */
export function newlyDone(prev: TaskDoc[], next: TaskDoc[]): TaskDoc[] {
  const was = new Map(prev.map((t) => [t.id, t.status]))
  return next.filter((t) => t.status === 'done' && was.has(t.id) && was.get(t.id) !== 'done')
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
  reload: () => void
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
  const [attempt, setAttempt] = useState(0)
  const statsTimer = useRef(0)
  const statusRef = useRef(status)
  statusRef.current = status

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!team) return
    let dead = false
    let dropped = false
    let retry = 0

    const loadStats = () =>
      getJson<StatsResponse>('/api/stats', { team_id: team })
        .then((s) => !dead && setStats(s))
        .catch((e: unknown) => console.error('stats refresh failed', e))

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
          setTasks((list) => mergeNew(list, t.tasks, (x) => x.created_at))
          setItems((list) => mergeNew(list, i.items, (x) => x.at))
          setDocs((list) => mergeNew(list, r.docs, (x) => x.at))
          setStats(s)
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
    loadBaseline(attempt > 0 && statusRef.current === 'ready')

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
    on<ItemDoc>('item', (d) => setItems((list) => upsert(list, d, (x) => x.at)))
    on<TaskDoc>('task', (d) => {
      setTasks((list) => upsert(list, d, (x) => x.created_at))
      statsSoon()
    })
    on<CaptureStatus>('capture', (c) => {
      setCaptures((list) => [c, ...list.filter((x) => x.capture_id !== c.capture_id)].slice(0, 50))
      if (c.state === 'indexed' || c.state === 'failed') statsSoon()
    })

    return () => {
      dead = true
      es.close()
      window.clearTimeout(retry)
      window.clearTimeout(statsTimer.current)
    }
  }, [team, attempt])

  return { status, error, conn, tasks, items, docs, captures, stats, reload }
}
