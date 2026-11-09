// What the phone companion shows: pure, so it runs in tests without a browser.
import type { ItemDoc, RawDoc, TaskDoc } from '@hh/shared'
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
export const justIn = (docs: RawDoc[], n = 5) => docs.filter((d) => !d.source_ref?.startsWith('task:')).slice(0, n)
