import type { TaskDoc } from '@hh/shared'
import { type FormEvent, Fragment, useEffect, useState } from 'react'
import { ago, clock, type Identity } from './live'
import { Mark } from './Mark'
import { type Block, inline, parseMarkdown } from './md'
import { type AcceptResult, acceptOrder, copyText, dismissOrder, orderFor, parsePaths } from './orders'

// A work order: what jam drafted, why it picked who it picked, and the three things a person can do with it.

function Inline({ text }: { text: string }) {
  return (
    <>
      {inline(text).map((s, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: a static split, never reordered
        s.t === 'code' ? <code key={i}>{s.text}</code> : s.t === 'b' ? <b key={i}>{s.text}</b> : <Fragment key={i}>{s.text}</Fragment>,
      )}
    </>
  )
}

function MdBlock({ b }: { b: Block }) {
  if (b.t === 'h') return <h4>{b.text}</h4>
  if (b.t === 'quote')
    return (
      <blockquote>
        <Inline text={b.text} />
      </blockquote>
    )
  if (b.t === 'code') return <pre>{b.text}</pre>
  if (b.t === 'checks')
    return (
      <ul className="md-checks">
        {b.items.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parsed once from a fixed string
          <li key={i}>
            <span className={c.done ? 'tick on' : 'tick'} aria-hidden="true" />
            <span className="sr">{c.done ? 'done: ' : 'to do: '}</span>
            <span><Inline text={c.text} /></span>
          </li>
        ))}
      </ul>
    )
  if (b.t === 'list')
    return (
      <ul className="md-list">
        {b.items.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parsed once from a fixed string
          <li key={i}><Inline text={x} /></li>
        ))}
      </ul>
    )
  return (
    <p>
      <Inline text={b.text} />
    </p>
  )
}

/** Server markdown as React text: no HTML from the spec ever reaches the DOM. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed once from a fixed string
        <MdBlock key={i} b={b} />
      ))}
    </div>
  )
}

type Props = { task: TaskDoc; id: Identity; onPut: (t: TaskDoc) => void; onDismissed: () => void }

type Busy = 'accept' | 'dismiss' | undefined
type Problem = Exclude<AcceptResult, { ok: true }> | { ok: false; kind: 'dismiss'; error: string }

export function WorkOrder({ task, id, onPut, onDismissed }: Props) {
  const [busy, setBusy] = useState<Busy>()
  const [problem, setProblem] = useState<Problem>()
  const [paths, setPaths] = useState('')
  const [copied, setCopied] = useState<'yes' | string>()

  // A different order starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the order changes
  useEffect(() => {
    setBusy(undefined)
    setProblem(undefined)
    setPaths('')
    setCopied(undefined)
  }, [task.id])

  useEffect(() => {
    if (copied !== 'yes') return
    const t = window.setTimeout(() => setCopied(undefined), 1800)
    return () => window.clearTimeout(t)
  }, [copied])

  const accept = async (withPaths?: string[]) => {
    setBusy('accept')
    setProblem(undefined)
    try {
      const r = await acceptOrder(id, task.id, withPaths)
      if (r.ok) onPut(r.task)
      else {
        if (r.kind !== 'paths') console.error(`accepting work order ${task.id} failed: ${r.error}`)
        setProblem(r)
      }
    } catch (e) {
      console.error(`accepting work order ${task.id} failed`, e)
      setProblem({ ok: false, kind: 'error', error: e instanceof Error ? e.message : 'The API did not answer.' })
    }
    setBusy(undefined)
  }

  const dismiss = async () => {
    setBusy('dismiss')
    setProblem(undefined)
    try {
      onPut(await dismissOrder(id, task.id))
      onDismissed()
    } catch (e) {
      console.error(`dismissing work order ${task.id} failed`, e)
      setProblem({ ok: false, kind: 'dismiss', error: e instanceof Error ? e.message : 'The API did not answer.' })
      setBusy(undefined)
    }
  }

  const copy = async () => {
    try {
      await copyText(task.spec ?? task.title)
      setCopied('yes')
    } catch (e) {
      console.error('copying the work order prompt failed', e)
      setCopied(e instanceof Error ? e.message : 'copy failed')
    }
  }

  const typed = parsePaths(paths)
  const submitPaths = (e: FormEvent) => {
    e.preventDefault()
    if (typed.length && !busy) void accept(typed)
  }

  return (
    <div className="transcript">
      <article className="col order">
        <div className="order-kicker">
          <Mark agent="jam" size={16} mode="waiting" />
          <span>Work order · drafted by jam at {clock(task.created_at)}</span>
        </div>
        <h2 className="order-title">{task.title}</h2>
        <div className="order-for">
          <span className="k">for</span>
          <b>{orderFor(task)}</b>
          {task.suggested_owner && <span className="dim">{task.side}</span>}
        </div>
        {task.reason && <p className="order-reason">{task.reason}</p>}

        <div className="order-actions">
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void accept()}>
            {busy === 'accept' ? 'Accepting…' : `Accept as ${id.who}`}
          </button>
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied === 'yes' ? 'Copied' : 'Copy prompt'}
          </button>
          <span className="grow" />
          <button type="button" className="text-btn" disabled={!!busy} onClick={() => void dismiss()}>
            {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
        <span className="sr" role="status">{copied === 'yes' ? 'Prompt copied' : ''}</span>
        {copied && copied !== 'yes' && <p className="order-msg bad" role="alert">Not copied: {copied}</p>}

        {problem?.kind === 'conflict' && (
          <div className="ask order-problem" role="alert">
            <span className="who">Can't accept yet</span>
            <p>{problem.error}</p>
            {problem.paths.length > 0 && <pre>{problem.paths.join('\n')}</pre>}
          </div>
        )}
        {(problem?.kind === 'error' || problem?.kind === 'dismiss') && (
          <p className="order-msg bad" role="alert">
            {problem.kind === 'dismiss' ? 'Not dismissed' : 'Not accepted'}: {problem.error}
          </p>
        )}
        {problem?.kind === 'paths' && (
          <form className="ask order-problem" onSubmit={submitPaths}>
            <span className="who">Which files will you edit?</span>
            <p>jam didn't propose any paths for this one. Name the files or folders you'll hold, then accept.</p>
            <div className="order-paths-in">
              <input
                value={paths}
                // biome-ignore lint/a11y/noAutofocus: the person just asked to accept and this is the one thing missing
                autoFocus
                aria-label="Paths to claim"
                placeholder={task.side === 'frontend' ? 'apps/web/src/…' : 'apps/api/src/…'}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setPaths(e.target.value)}
              />
              <button type="submit" className="btn primary" disabled={!typed.length || !!busy}>
                {busy === 'accept' ? 'Accepting…' : 'Accept'}
              </button>
            </div>
            <span className="prov">Separate with commas or spaces. A trailing slash claims the whole folder.</span>
          </form>
        )}

        <section className="call">
          <div className="row">
            <span className="tool">paths</span>
            <span className="ok">{task.paths.length ? `${task.paths.length} proposed` : 'none yet'}</span>
          </div>
          <div className="body">
            {task.paths.length ? <pre>{task.paths.join('\n')}</pre> : <p className="order-none">You name them when you accept.</p>}
          </div>
        </section>

        {task.spec ? (
          <section className="order-spec" aria-label="Build prompt">
            <Markdown text={task.spec} />
          </section>
        ) : (
          <p className="note">jam didn't write a build prompt for this one.</p>
        )}
      </article>
    </div>
  )
}

/** Under the feed's path row: the proposed work orders, so they can't be missed. */
export function OrderStrip({ orders, now, onOpen }: { orders: TaskDoc[]; now: number; onOpen: (id: string) => void }) {
  if (!orders.length) return null
  return (
    <section className="orders" aria-label="Proposed by jam">
      <div className="orders-head">
        <span className="glyph glyph-needs_input" aria-hidden="true" />
        <span>Proposed by jam</span>
        <span className="count">{orders.length}</span>
      </div>
      <ul>
        {orders.map((t) => (
          <li key={t.id}>
            <button type="button" className="order-row" onClick={() => onOpen(t.id)}>
              <span className="o-title">{t.title}</span>
              <span className="o-time">{ago(t.created_at, now)}</span>
              <span className="o-meta">
                for <b>{orderFor(t)}</b>
                {t.reason ? ` · ${t.reason}` : ''}
              </span>
              <span className="o-open">Open</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
