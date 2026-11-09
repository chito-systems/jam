// Work orders: tasks jam drafted from something the team said, waiting for a person to take them.
// Types only from @hh/shared (a value import would pull the Elasticsearch client into the bundle).
import type { ChaosState, TaskConflict, TaskDoc } from '@hh/shared'
import { agentName, sortTasks } from './live'

// ---------- pure helpers (tested in orders.test.ts) ----------

/** A work order someone waved off: dropped while still jam's, never accepted. */
export const isDismissed = (t: TaskDoc) => t.status === 'released' && !!t.proposed_by && t.owner === t.proposed_by

/** Proposed work orders, newest first. */
export const proposedOrders = (tasks: TaskDoc[]) =>
  tasks.filter((t) => t.status === 'proposed').sort((a, b) => b.created_at.localeCompare(a.created_at))

/** Everything else in the task list: claims and finished work, minus dismissed work orders. */
export const workTasks = (tasks: TaskDoc[]) => sortTasks(tasks.filter((t) => t.status !== 'proposed' && !isDismissed(t)))

/** Who a work order is for: the person jam suggested, else the side of the team. */
export const orderFor = (t: TaskDoc) => (t.suggested_owner ? agentName(t.suggested_owner) : `${t.side} side`)

/** "apps/web/src/a.ts, apps/api/" or one per line → clean, de-duplicated paths (the API allows 20). */
export function parsePaths(input: string): string[] {
  const out = input
    .split(/[\s,]+/)
    .map((p) => p.trim().replace(/^\.\//, ''))
    .filter(Boolean)
  return [...new Set(out)].slice(0, 20)
}

export type AcceptResult =
  | { ok: true; task: TaskDoc }
  /** 409: someone holds a path, or a path belongs to the other side. `error` names who. */
  | { ok: false; kind: 'conflict'; error: string; paths: string[] }
  /** 400 because jam proposed no paths: ask for them and retry. */
  | { ok: false; kind: 'paths'; error: string }
  | { ok: false; kind: 'error'; error: string }

/** Reads an /accept response body into what the card should do next. */
export function acceptOutcome(status: number, body: unknown): AcceptResult {
  const err = (body as { error?: unknown } | null)?.error
  const text = typeof err === 'string' ? err : `accept answered ${status}`
  if (status >= 200 && status < 300) return { ok: true, task: body as TaskDoc }
  if (status === 409) return { ok: false, kind: 'conflict', error: text, paths: (body as TaskConflict | null)?.offending_paths ?? [] }
  if (status === 400 && /no paths/i.test(text)) return { ok: false, kind: 'paths', error: text }
  return { ok: false, kind: 'error', error: text }
}

// ---------- http ----------

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function failText(res: Response, what: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `${what} answered ${res.status}`
}

type Who = { team: string; who: string }

/** POST /api/tasks/:id/accept. Never throws for an HTTP answer; a network failure still throws. */
export async function acceptOrder(id: Who, taskId: string, paths?: string[]): Promise<AcceptResult> {
  const res = await post(`/api/tasks/${encodeURIComponent(taskId)}/accept`, { team_id: id.team, who: id.who, ...(paths ? { paths } : {}) })
  return acceptOutcome(res.status, await res.json().catch(() => null))
}

/** POST /api/tasks/:id/close with status "released": how a work order is dismissed. */
export async function dismissOrder(id: Who, taskId: string): Promise<TaskDoc> {
  const res = await post(`/api/tasks/${encodeURIComponent(taskId)}/close`, { team_id: id.team, who: id.who, status: 'released' })
  if (!res.ok) throw new Error(await failText(res, 'dismiss'))
  return (await res.json()) as TaskDoc
}

/** POST /api/chaos. 403 when the deployment has the switch turned off. */
export async function setChaos(id: Who, enabled: boolean): Promise<ChaosState> {
  const res = await post('/api/chaos', { team_id: id.team, who: id.who, enabled })
  if (!res.ok) throw new Error(await failText(res, 'chaos'))
  return (await res.json()) as ChaosState
}

/** Clipboard API where allowed; a hidden textarea on plain http, where it is not. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.append(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('this browser blocked the clipboard')
}
