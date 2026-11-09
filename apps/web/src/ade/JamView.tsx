import type { ItemDoc, TaskDoc } from '@hh/shared'
import type { ReactNode } from 'react'
import { ago } from './live'
import { OrderStrip } from './WorkOrder'

// The centre pane for jam, the shared librarian: what it proposed, what it needs a person to
// confirm, and which of its work orders someone took.

type Props = {
  orders: TaskDoc[]
  pending: ItemDoc[]
  assigned: TaskDoc[]
  now: number
  owner: (who: string) => string
  onOpen: (id: string) => void
  item: (i: ItemDoc) => ReactNode
}

export function JamView({ orders, pending, assigned, now, owner, onOpen, item }: Props) {
  return (
    <div className="transcript jam-view">
      <OrderStrip orders={orders} now={now} onOpen={onOpen} />
      {!orders.length && <p className="pane-empty">No work orders waiting. jam drafts them from todos the team says out loud.</p>}
      <div className="col">
        <div className="sec">
          <span>NEEDS A HUMAN</span>
          <span>{pending.length || ''}</span>
        </div>
        {pending.map(item)}
        {!pending.length && <p className="pane-empty">Nothing to confirm. Every decision, todo and question has a verdict.</p>}
        <div className="sec">
          <span>ASSIGNED</span>
          <span>{assigned.length || ''}</span>
        </div>
        {assigned.length > 0 && (
          <section className="orders" aria-label="Assigned work orders">
            <ul>
              {assigned.map((t) => (
                <li key={t.id}>
                  <button type="button" className="order-row" onClick={() => onOpen(t.id)}>
                    <span className="o-title">{t.title}</span>
                    <span className="o-time">{ago(t.updated_at, now)}</span>
                    <span className="o-meta">
                      {t.status === 'done' ? 'done by' : 'taken by'} <b>{owner(t.owner)}</b> · {t.side}
                    </span>
                    <span className="o-open">Open</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!assigned.length && <p className="pane-empty">No accepted work orders yet.</p>}
      </div>
    </div>
  )
}
