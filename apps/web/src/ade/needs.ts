// What the phone companion shows: pure, so it runs in tests without a browser.
import type { CaptureStatus, ItemDoc, RawDoc, TaskDoc } from '@hh/shared'
import { proposedOrders } from './orders'

/** Librarian items worth a person's yes or no: the ones that steer work. */
const ASKS: ItemDoc['kind'][] = ['decision', 'todo', 'blocker', 'question']

/** What needs a person, newest first: work orders, then unanswered librarian items. */
export function needsYou(tasks: TaskDoc[], items: ItemDoc[], handled: Set<string>, max = 4) {
  const orders = proposedOrders(tasks).filter((t) => !handled.has(t.id))
  const asks = items
    .filter((i) => !i.verdict && i.status === 'open' && ASKS.includes(i.kind) && !handled.has(i.id))
    .sort((a, b) => b.at.localeCompare(a.at))
  return { orders: orders.slice(0, max), asks: asks.slice(0, Math.max(0, max - Math.min(orders.length, max))), total: orders.length + asks.length }
}

/** The last few things said, one line each, without the agents' task bookkeeping. */
/** The last few things people and agents said, one line each: no task bookkeeping, no PR/review traffic. */
export const justIn = (docs: RawDoc[], n = 5) =>
  docs.filter((d) => !d.source_ref?.startsWith('task:') && d.type !== 'pr' && d.type !== 'review').slice(0, n)

/** Something this phone sent: a voice clip or a note, before and after the brain has it. */
export type Sent = { key: string; capture_id?: string; error?: string }
export type SentRow = { key: string; state: 'sending' | 'queued' | 'transcribing' | 'indexing' | 'in' | 'failed'; text?: string; ms?: number; error?: string }

/** Where each thing this phone sent has got to, newest first, with the words once the brain has them. */
export function sentRows(sent: Sent[], captures: CaptureStatus[], docs: RawDoc[]): SentRow[] {
  return sent.map((o): SentRow => {
    if (o.error) return { key: o.key, state: 'failed', error: o.error }
    if (!o.capture_id) return { key: o.key, state: 'sending' }
    const chunks = docs.filter((d) => d.capture_id === o.capture_id).sort((a, b) => a.id.localeCompare(b.id))
    const c = captures.find((x) => x.capture_id === o.capture_id)
    if (chunks.length) return { key: o.key, state: 'in', text: chunks.map((d) => d.text).join(' '), ms: c?.ms_to_searchable }
    if (!c) return { key: o.key, state: 'queued' }
    if (c.state === 'failed') return { key: o.key, state: 'failed', error: c.error ?? 'the brain could not use it' }
    if (c.state === 'indexed') return { key: o.key, state: 'in', ms: c.ms_to_searchable }
    return { key: o.key, state: c.state }
  })
}
