// JAM on a phone: a companion to the laptop ADE, not a smaller copy of it.
// What the phone is for: see which agents are working, answer what needs a person
// (work orders, the librarian's guesses), and say things into the brain from anywhere.
// Reading transcripts, files and the terminal stays on the laptop.
import type { ItemDoc, ItemVerdict, TaskDoc } from '@hh/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './companion.css'
import { armAudio, playChime } from './chime'
import { Guide, guideSeen, HelpIcon } from './Guide'
import { addNote, agentName, ago, type Identity, isAgent, type Live, newlyDone, setVerdict } from './live'
import { Mark } from './Mark'
import { justIn, needsYou, type Sent, sentRows } from './needs'
import { acceptOrder, dismissOrder, orderFor } from './orders'
import { FreezeClock } from './parts'
import { Talk } from './Talk'

const SENT_LABEL = { sending: 'Sending…', queued: 'Sent. Waiting for the brain…', transcribing: 'Transcribing…', indexing: 'Filing it in the brain…' } as const
const KIND_LABEL: Partial<Record<ItemDoc['kind'], string>> = { decision: 'Decision', todo: 'Todo', blocker: 'Blocker', question: 'Question' }

export function Companion({ id, live, onSignOut }: { id: Identity; live: Live; onSignOut: () => void }) {
  const [now, setNow] = useState(Date.now)
  const [guide, setGuide] = useState(() => !guideSeen())
  const [handled, setHandled] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState('')
  const [writing, setWriting] = useState(false)
  // What this phone sent, so a clip is visible from the tap until the brain has the words.
  const [sent, setSent] = useState<Sent[]>([])
  const track = useCallback((o: Sent) => setSent((list) => [o, ...list.filter((x) => x.key !== o.key)].slice(0, 3)), [])
  const prev = useRef<TaskDoc[] | null>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(armAudio, [])

  // An agent finishing is the moment the phone is for: chime, haptic, a line at the top.
  useEffect(() => {
    if (live.status !== 'ready') return
    const before = prev.current
    prev.current = live.tasks
    const t = before && newlyDone(before, live.tasks)[0]
    if (!t) return
    playChime('done')
    setToast(`${agentName(t.owner)} finished: ${t.title}`)
  }, [live.status, live.tasks])
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 5000)
    return () => window.clearTimeout(t)
  }, [toast])

  const working = useMemo(() => live.tasks.filter((t) => t.status === 'claimed').sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [live.tasks])
  const needs = useMemo(() => needsYou(live.tasks, live.items, handled), [live.tasks, live.items, handled])
  const recent = useMemo(() => justIn(live.docs), [live.docs])
  const mine = useMemo(() => sentRows(sent, live.captures, live.docs), [sent, live.captures, live.docs])
  const done = (key: string) => setHandled((s) => new Set(s).add(key))

  return (
    <div className="ade companion">
      <header className="c-top">
        <Mark agent="jam" size={22} />
        <span className="wm">JAM</span>
        <span className="c-team">{id.team}</span>
        {live.stats?.chaos && <span className="chaos-tag">CHAOS</span>}
        <span className="grow" />
        <FreezeClock />
        <button type="button" className="icon" aria-label="Setup and account" onClick={() => setGuide(true)}>
          <HelpIcon />
        </button>
      </header>
      {toast && <p className="c-toast" role="status">{toast}</p>}

      <main className="c-body">
        {live.status === 'loading' && <p className="c-empty">Reading the team brain…</p>}
        {live.status === 'error' && (
          <p className="c-empty bad" role="alert">
            The brain did not answer. {live.error} <button type="button" className="text-btn" onClick={live.reload}>Try again</button>
          </p>
        )}

        <section aria-labelledby="c-now">
          <h2 id="c-now" className="c-sec"><span>Now</span><span>{working.length ? `${working.length} working` : 'quiet'}</span></h2>
          {working.length ? (
            <ul className="c-now">
              {working.map((t) => (
                <li key={t.id}>
                  <Mark agent={t.owner} size={30} mode="working" />
                  <span className="c-title">{t.title}</span>
                  <span className="c-meta">{agentName(t.owner)} · {t.side} · {ago(t.created_at, now)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="c-empty">No agent holds a task right now.</p>
          )}
        </section>

        <section aria-labelledby="c-needs">
          <h2 id="c-needs" className="c-sec"><span>Needs you</span><span>{needs.total || ''}</span></h2>
          {needs.orders.map((t) => <OrderCard key={t.id} task={t} id={id} live={live} onDone={() => done(t.id)} />)}
          {needs.asks.map((i) => <AskCard key={i.id} item={i} id={id} onDone={() => done(i.id)} />)}
          {!needs.total && live.status === 'ready' && <p className="c-empty">Nothing needs you. Say what you are working on below.</p>}
        </section>

        <section aria-labelledby="c-in">
          <h2 id="c-in" className="c-sec"><span>Just in</span><span /></h2>
          <ul className="c-in">
            {mine.map((r) => (
              <li key={r.key} className="c-mine" data-state={r.state}>
                <span className="av">{id.who.slice(0, 1).toUpperCase()}</span>
                <span className="c-line">
                  <b>You</b> {r.state === 'in' ? (r.text ?? 'In the brain.') : r.state === 'failed' ? `Not saved: ${r.error}` : SENT_LABEL[r.state]}
                </span>
                <span className="c-ago">{r.state === 'in' ? (r.ms ? `in ${(r.ms / 1000).toFixed(1)}s` : 'in') : ''}</span>
              </li>
            ))}
            {recent.filter((d) => !sent.some((o) => o.capture_id === d.capture_id)).map((d) => (
              <li key={d.id}>
                {isAgent(d.who) ? <Mark agent={d.who} size={16} /> : <span className="av">{d.who.slice(0, 1).toUpperCase()}</span>}
                <span className="c-line"><b>{agentName(d.who)}</b> {d.text}</span>
                <span className="c-ago">{ago(d.at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="c-dock">
        <button type="button" className="c-write" aria-label="Type a note" onClick={() => setWriting(true)}>
          <PenIcon />
        </button>
        <div className="c-talk">
          <Talk id={id} onOutgoing={track} toggle />
        </div>
      </footer>

      {writing && <NoteSheet id={id} onSent={track} onClose={() => setWriting(false)} />}
      {guide && <Guide id={id} live={live} onSignOut={onSignOut} onClose={() => setGuide(false)} />}
    </div>
  )
}

function OrderCard({ task, id, live, onDone }: { task: TaskDoc; id: Identity; live: Live; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const mine = orderFor(task) === id.who
  const accept = async () => {
    setBusy(true)
    setMsg('')
    const r = await acceptOrder(id, task.id).catch((e: unknown) => ({ ok: false as const, kind: 'error' as const, error: e instanceof Error ? e.message : String(e) }))
    setBusy(false)
    if (r.ok) {
      live.putTask(r.task)
      playChime('sent')
      return onDone()
    }
    // Choosing paths or settling a clash is laptop work; say so instead of half-doing it here.
    if (r.kind === 'paths') return setMsg('This one needs file paths first. Accept it on your laptop.')
    if (r.kind === 'conflict') return setMsg(`${r.error} Sort it out on your laptop.`)
    playChime('error')
    setMsg(r.error)
  }
  const dismiss = async () => {
    setBusy(true)
    try {
      live.putTask(await dismissOrder(id, task.id))
      onDone()
    } catch (e) {
      console.error('dismissing a work order failed', e)
      setMsg(e instanceof Error ? e.message : 'Not dismissed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="c-card">
      <p className="c-kind">Work order · for <b className={mine ? 'you' : undefined}>{mine ? 'you' : orderFor(task)}</b></p>
      <p className="c-text">{task.title}</p>
      {task.reason && <p className="c-why">{task.reason}</p>}
      {msg && <p className="c-msg bad" role="alert">{msg}</p>}
      <div className="c-acts">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void accept()}>Accept</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void dismiss()}>Not now</button>
      </div>
    </article>
  )
}

function AskCard({ item, id, onDone }: { item: ItemDoc; id: Identity; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const answer = async (v: ItemVerdict) => {
    setBusy(true)
    try {
      await setVerdict(id, item.id, v)
      playChime(v === 'confirmed' ? 'sent' : 'cancel')
      onDone()
    } catch (e) {
      console.error('saving a verdict failed', e)
      setMsg(e instanceof Error ? e.message : 'Not saved.')
      setBusy(false)
    }
  }
  return (
    <article className="c-card">
      <p className="c-kind">
        {KIND_LABEL[item.kind] ?? item.kind} · {agentName(item.who)}
        {item.confidence !== undefined && <span className="c-conf"> · jam is {Math.round(item.confidence * 100)}% sure</span>}
      </p>
      <p className="c-text">{item.text}</p>
      {msg && <p className="c-msg bad" role="alert">{msg}</p>}
      <div className="c-acts">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void answer('confirmed')}>Yes, we said that</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer('rejected')}>No</button>
      </div>
    </article>
  )
}

function NoteSheet({ id, onSent, onClose }: { id: Identity; onSent: (s: Sent) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const save = async () => {
    const t = text.trim()
    if (!t || state.busy) return
    setState({ busy: true })
    try {
      const res = await addNote(id, t)
      onSent({ key: res.capture_id, capture_id: res.capture_id })
      playChime('sent')
      onClose()
    } catch (e) {
      console.error('adding a note from the phone failed', e)
      setState({ busy: false, error: e instanceof Error ? e.message : 'Not saved.' })
    }
  }
  return (
    <div className="c-sheet-wrap">
      <button type="button" className="c-scrim" aria-label="Close" onClick={onClose} />
      <div className="c-sheet" role="dialog" aria-modal="true" aria-label="Note to the brain">
        {/* biome-ignore lint/a11y/noAutofocus: the sheet exists only to type into */}
        <textarea autoFocus rows={4} value={text} placeholder="What should every agent know?" onChange={(e) => setText(e.target.value)} />
        {state.error && <p className="c-msg bad" role="alert">{state.error}</p>}
        <div className="c-acts">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!text.trim() || state.busy} onClick={() => void save()}>
            {state.busy ? 'Saving…' : 'Save to the brain'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PenIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M13.5 3.5l3 3L7 16H4v-3z" />
      <path d="M11.5 5.5l3 3" />
    </svg>
  )
}
