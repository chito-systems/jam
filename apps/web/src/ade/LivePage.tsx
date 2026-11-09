import type { CaptureStatus, ItemDoc, RawDoc, SearchHit, TaskDoc } from '@hh/shared'
import { type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/bricolage-grotesque/800.css'
import './ade.css'
import type { RunState } from './data'
import { armAudio, playChime, setSound, soundOn } from './chime'
import { addNote, agentName, ago, clock, formatMs, type Identity, isAgent, type Live, loadIdentity, newlyDone, saveIdentity, searchBrain, sortTasks, threadFor, useLive } from './live'
import { Mark, type MarkMode, ThemeCtx } from './Mark'
import { type Command, FreezeClock, MenuIcon, Palette, PaneIcon, Prose, SoundIcon, StatusGlyph, ThemeIcon, useTheme } from './parts'
import { Guide, guideSeen, HelpIcon } from './Guide'
import { type Outgoing, Talk } from './Talk'

// The ADE on real data. The API has tasks, brain entries, captures and stats; it has no
// agent transcripts yet, so a "session" here is a task claim and what the brain holds about it.

const FEED = 'feed'
const TASK_STATE: Record<TaskDoc['status'], RunState> = { proposed: 'needs_input', claimed: 'running', done: 'done', released: 'cancelled' }
const TASK_LABEL: Record<TaskDoc['status'], string> = { proposed: 'Proposed', claimed: 'Working', done: 'Done', released: 'Released' }
const TASK_MARK: Record<TaskDoc['status'], MarkMode> = { proposed: 'waiting', claimed: 'working', done: 'still', released: 'idle' }
const CAPTURE_LABEL: Record<CaptureStatus['state'], string> = {
  queued: 'queued',
  transcribing: 'transcribing',
  indexing: 'indexing',
  indexed: 'searchable',
  failed: 'failed',
}

type RightTab = 'brain' | 'files'

export function LivePage() {
  const { theme, flip } = useTheme()
  const [id, setId] = useState<Identity | null>(loadIdentity)
  return (
    <ThemeCtx.Provider value={theme}>
      {id ? <Shell id={id} theme={theme} flip={flip} onSignOut={() => setId(null)} /> : <Join onJoin={setId} />}
    </ThemeCtx.Provider>
  )
}

// ---------- identity ----------

function Join({ onJoin }: { onJoin: (id: Identity) => void }) {
  const [team, setTeam] = useState('')
  const [who, setWho] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (team.trim() && who.trim()) onJoin(saveIdentity(team, who))
  }
  return (
    <div className="ade join">
      <form className="join-card" onSubmit={submit}>
        <div className="join-head">
          <Mark agent="jam" size={28} />
          <span className="wm">JAM</span>
        </div>
        <p className="dim">Enter your team code and name. They stay in this browser, and the capture page uses the same ones.</p>
        <label>
          <span>Team code</span>
          <input value={team} maxLength={64} onChange={(e) => setTeam(e.target.value)} autoComplete="off" autoCapitalize="none" required />
        </label>
        <label>
          <span>Your name</span>
          <input value={who} maxLength={64} onChange={(e) => setWho(e.target.value)} autoComplete="given-name" autoCapitalize="none" required />
        </label>
        <button type="submit" className="btn primary" disabled={!team.trim() || !who.trim()}>
          Open the workspace
        </button>
      </form>
    </div>
  )
}

// ---------- shell ----------

function Shell({ id, theme, flip, onSignOut }: { id: Identity; theme: 'light' | 'dark'; flip: () => void; onSignOut: () => void }) {
  const live = useLive(id.team)
  const [activeId, setActiveId] = useState(FEED)
  const [tab, setTab] = useState<RightTab>('brain')
  const [palette, setPalette] = useState(false)
  const [guide, setGuide] = useState(() => !guideSeen())
  const [widths, setWidths] = useState({ left: 256, right: 340 })
  const [side, setSide] = useState<'none' | 'left' | 'right'>('none')
  const [now, setNow] = useState(Date.now)
  const [sound, setSoundState] = useState(soundOn)
  const [finished, setFinished] = useState('')
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const prevTasks = useRef<TaskDoc[] | null>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  useEffect(armAudio, [])

  // Chime when the stream moves a task to done; the first load is the baseline.
  useEffect(() => {
    if (live.status !== 'ready') return
    const prev = prevTasks.current
    prevTasks.current = live.tasks
    const t = prev && newlyDone(prev, live.tasks)[0]
    if (!t) return
    playChime('done')
    setFinished(`${agentName(t.owner)} finished: ${t.title}`)
  }, [live.status, live.tasks])
  useEffect(() => {
    if (!finished) return
    const t = window.setTimeout(() => setFinished(''), 6000)
    return () => window.clearTimeout(t)
  }, [finished])

  const toggleSound = () => {
    setSound(!sound)
    setSoundState(!sound)
  }
  const track = useCallback((o: Outgoing) => setOutgoing((list) => [o, ...list.filter((x) => x.key !== o.key)].slice(0, 20)), [])

  const tasks = useMemo(() => sortTasks(live.tasks), [live.tasks])
  const active = tasks.find((t) => t.id === activeId)
  const open = tasks.filter((t) => t.status === 'claimed')
  const order = useMemo(() => [FEED, ...tasks.map((t) => t.id)], [tasks])

  const select = useCallback((next: string) => {
    setActiveId(next)
    setSide('none')
  }, [])

  const show = useCallback((t: RightTab) => {
    setTab(t)
    setSide('right')
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (guide) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (palette) return
      const el = e.target as HTMLElement
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        show('brain')
        window.setTimeout(() => document.querySelector<HTMLInputElement>('.ade .search input')?.focus(), 0)
      }
      if (e.key === 'j' || e.key === 'k') {
        const i = order.indexOf(activeId)
        const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))]
        if (next) select(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, order, palette, guide, select, show])

  const drag = (which: 'left' | 'right') => (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const start = widths[which]
    const move = (m: PointerEvent) => {
      const d = (m.clientX - startX) * (which === 'left' ? 1 : -1)
      setWidths((w) => ({ ...w, [which]: Math.min(640, Math.max(200, start + d)) }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const commands: Command[] = [
    { label: 'Open the capture page', hint: 'hold ⌥Space here', run: () => window.location.assign('/c') },
    { label: sound ? 'Turn sound off' : 'Turn sound on', run: toggleSound },
    { label: 'Search the brain', hint: '/', run: () => show('brain') },
    { label: 'Show claimed files', run: () => show('files') },
    { label: 'Team feed', run: () => select(FEED) },
    { label: theme === 'dark' ? 'Switch to light' : 'Switch to dark', run: flip },
    { label: 'Open the setup guide', run: () => setGuide(true) },
    { label: 'Change team or name', hint: `${id.team} · ${id.who}`, run: onSignOut },
    ...tasks.map((t) => ({ id: t.id, label: t.title, hint: `${agentName(t.owner)} · ${TASK_LABEL[t.status]}`, agent: t.owner, run: () => select(t.id) })),
  ]

  const people = Object.entries(live.stats?.by_who ?? {}).sort((a, b) => b[1] - a[1])

  return (
    <div className="ade" data-side={side} style={{ '--w-left': `${widths.left}px`, '--w-right': `${widths.right}px` } as CSSProperties}>
      <header className="bar">
        <button type="button" className="icon only-narrow" aria-label="Tasks" onClick={() => setSide(side === 'left' ? 'none' : 'left')}>
          <MenuIcon />
        </button>
        <Mark agent="jam" size={22} />
        <span className="wm">JAM</span>
        <span className="crumb">team <b>{id.team}</b></span>
        <button type="button" className="cmd" onClick={() => setPalette(true)}>
          <span>Search tasks and commands</span>
          <kbd>⌘K</kbd>
        </button>
        <FreezeClock />
        <Talk id={id} onOutgoing={track} />
        <button type="button" className="icon" aria-label="Sound" aria-pressed={sound} title={sound ? 'Sound on' : 'Sound off'} onClick={toggleSound}>
          <SoundIcon on={sound} />
        </button>
        <button type="button" className="icon" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={flip}>
          <ThemeIcon theme={theme} />
        </button>
        <button type="button" className="icon" aria-label="Open the setup guide" aria-haspopup="dialog" title="Setup guide" onClick={() => setGuide(true)}>
          <HelpIcon />
        </button>
        <button type="button" className="icon only-narrow" aria-label="Brain pane" onClick={() => setSide(side === 'right' ? 'none' : 'right')}>
          <PaneIcon />
        </button>
      </header>

      <nav className="left" aria-label="Tasks">
        <div className="sec">
          <span>WORK</span>
          <span>{open.length} working</span>
        </div>
        <ul className="sessions">
          <li>
            <button type="button" className="session" aria-current={activeId === FEED} onClick={() => select(FEED)}>
              <Mark agent="jam" size={28} />
              <span className="s-title">Team feed</span>
              <span className="s-time">{live.docs[0] ? ago(live.docs[0].at, now) : ''}</span>
              <span className="s-meta">Everything said, pasted and posted</span>
            </button>
          </li>
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="session" aria-current={t.id === activeId} onClick={() => select(t.id)}>
                <Mark agent={t.owner} size={28} mode={TASK_MARK[t.status]} />
                <span className="s-title">{t.title}</span>
                <span className="s-time">{ago(t.updated_at, now)}</span>
                <span className="s-meta">
                  {TASK_LABEL[t.status]} · {agentName(t.owner)} · {t.side}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {live.status === 'ready' && !tasks.length && (
          <p className="pane-empty">No task is claimed yet. An agent claims one with the task_claim tool, and it appears here.</p>
        )}
        <div className="sec">
          <span>PEOPLE AND AGENTS</span>
          <span>{people.length}</span>
        </div>
        {people.map(([who, n]) => (
          <div key={who} className="hu">
            {isAgent(who) ? <Mark agent={who} size={20} /> : <span className="av">{who.slice(0, 1).toUpperCase()}</span>}
            {agentName(who)}
            <span className="s">{n} in brain</span>
          </div>
        ))}
        <span className="grow" />
        <div className="left-foot"><kbd>j</kbd> <kbd>k</kbd> move between tasks</div>
      </nav>
      <div className="divider d-left" onPointerDown={drag('left')} />

      <main className="center">
        <div className="path">
          {active ? (
            <>
              <StatusGlyph state={TASK_STATE[active.status]} />
              <span className="t-title">{active.title}</span>
              <span>owner <b>{agentName(active.owner)}</b></span>
              <span>side <b>{active.side}</b></span>
              {active.pr && <span>PR <b>{active.pr}</b></span>}
              <span>claimed <b>{clock(active.created_at)}</b></span>
            </>
          ) : (
            <>
              <span className="t-title">Team feed</span>
              <span>captures <b>{live.stats?.raw_total ?? 0}</b></span>
              <span>items <b>{live.stats?.items_total ?? 0}</b></span>
            </>
          )}
        </div>
        <Thread live={live} task={active} id={id} outgoing={outgoing} />
        <NoteBox id={id} />
        <BottomPanel live={live} now={now} onSelect={select} />
      </main>
      <div className="divider d-right" onPointerDown={drag('right')} />

      <aside className="right" aria-label="Brain">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'brain'} onClick={() => setTab('brain')}>
            Brain
            {live.stats && <span className="count">{live.stats.items_total + live.stats.raw_total}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
            Files
            {open.length > 0 && <span className="count">{open.reduce((n, t) => n + t.paths.length, 0)}</span>}
          </button>
        </div>
        <div className="right-body">
          {tab === 'brain' ? <Brain live={live} team={id.team} task={active} /> : <Files tasks={active ? [active] : open} />}
        </div>
      </aside>

      <footer className="sb">
        <span><b>{id.team}</b></span>
        <span className="extra">{live.stats?.raw_total ?? 0} captures</span>
        <span className="extra">{live.stats?.items_total ?? 0} items</span>
        <span>{live.stats?.open_tasks ?? 0} open tasks</span>
        <span className="sb-done" role="status">{finished}</span>
        <span className="extra">searchable p50 <b>{formatMs(live.stats?.slo.p50_ms)}</b></span>
        <span className="sp" />
        <button type="button" className="sb-btn" aria-label="Change team or name" title="Change team or name" onClick={onSignOut}>{id.who}</button>
        {!id.persisted && <span className="bad" role="status" title="This browser blocked storage, so the capture page will ask for your team and name again.">this tab only</span>}
        <span>{live.conn}</span>
      </footer>

      {side !== 'none' && <button type="button" className="scrim" aria-label="Close pane" onClick={() => setSide('none')} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {guide && <Guide id={id} live={live} onSignOut={onSignOut} onClose={() => setGuide(false)} />}
    </div>
  )
}

// ---------- centre: what the brain holds about the task, or the whole feed ----------

function Entry({ doc }: { doc: RawDoc }) {
  const meta = `${agentName(doc.who)} · ${doc.type} · ${clock(doc.at)}`
  if (doc.source_ref?.startsWith('task:')) return <p className="note">{clock(doc.at)} · {doc.text}</p>
  if (isAgent(doc.who))
    return (
      <div className="ev say">
        <Mark agent={doc.who} size={18} />
        <div>
          <Prose text={doc.text} />
          <div className="cites"><span>{meta}</span></div>
        </div>
      </div>
    )
  return (
    <div className="ev human">
      <span className="av">{doc.who.slice(0, 1).toUpperCase()}</span>
      <div>
        <small>{meta}</small>
        <Prose text={doc.text} />
      </div>
    </div>
  )
}

function Thread({ live, task, id, outgoing }: { live: Live; task: TaskDoc | undefined; id: Identity; outgoing: Outgoing[] }) {
  const box = useRef<HTMLDivElement>(null)
  const docs = useMemo(() => (task ? threadFor(task, live.docs) : [...live.docs].reverse()), [task, live.docs])
  const pending = live.captures.filter((c) => c.state !== 'indexed')
  const sending = outgoing.filter((o) => !live.captures.some((c) => c.capture_id === o.capture_id))
  const [openPaths, setOpenPaths] = useState(true)
  const count = docs.length + pending.length + sending.length

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection or the number of entries changes
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [task?.id, count])

  if (live.status === 'loading') return <div className="transcript empty"><p className="dim" role="status">Loading the team brain…</p></div>
  if (live.status === 'error')
    return (
      <div className="transcript empty" role="alert">
        <p>The API did not answer.</p>
        <p className="dim">{live.error}</p>
        <button type="button" className="btn" onClick={live.reload}>Try again</button>
      </div>
    )
  if (!task && !count)
    return (
      <div className="transcript empty">
        <p>The brain is empty for team {id.team}.</p>
        <p className="dim">Hold Talk, or write a note below. It shows up here the moment it is searchable.</p>
      </div>
    )

  return (
    <div className="transcript" ref={box}>
      <div className="col">
        {task && (
          <div className="ev call">
            <button type="button" className="row" aria-expanded={openPaths} onClick={() => setOpenPaths(!openPaths)}>
              <span className="t">{openPaths ? '▾' : '▸'}</span>
              <span className="tool">task_claim</span>
              <span className="t target">{agentName(task.owner)} is editing</span>
              <span className="ok">{task.paths.length} {task.paths.length === 1 ? 'path' : 'paths'}</span>
            </button>
            {openPaths && (
              <div className="body">
                <pre>{task.paths.join('\n')}</pre>
              </div>
            )}
          </div>
        )}
        {docs.map((d) => (
          <Entry key={d.id} doc={d} />
        ))}
        {task?.note && <p className="note">Closing note: {task.note}</p>}
        {task && !docs.length && <p className="note">Nothing in the brain about this task yet.</p>}
        {!task &&
          pending.map((c) => (
            <p key={c.capture_id} className={c.state === 'failed' ? 'note bad' : 'note'} role="status">
              {agentName(c.who)} · {c.type} · {CAPTURE_LABEL[c.state]}
              {c.error ? `: ${c.error}` : '…'}
            </p>
          ))}
        {!task &&
          sending.map((o) => (
            <p key={o.key} className={o.error ? 'note bad' : 'note'} role={o.error ? 'alert' : 'status'}>
              {id.who} · voice · {o.error ? `not sent: ${o.error}` : o.capture_id ? 'queued…' : 'sending…'}
            </p>
          ))}
      </div>
    </div>
  )
}

function NoteBox({ id }: { id: Identity }) {
  const [text, setText] = useState('')
  const [state, setState] = useState<{ busy: boolean; error?: string; sent?: boolean }>({ busy: false })
  const submit = async () => {
    const t = text.trim()
    if (!t || state.busy) return
    setState({ busy: true })
    try {
      await addNote(id, t)
      setText((cur) => (cur.trim() === t ? '' : cur))
      setState({ busy: false, sent: true })
    } catch (e) {
      console.error('adding a note to the brain failed', e)
      setState({ busy: false, error: e instanceof Error ? e.message : 'The note was not saved.' })
    }
  }
  return (
    <div className="composer">
      <div className="col">
        {state.error && <div className="queued" role="alert"><span className="q-text bad">Not saved: {state.error}</span></div>}
        <div className="box">
          <textarea
            rows={2}
            value={text}
            aria-label="Add a note to the brain"
            placeholder="Add a note to the brain. Every agent can search it."
            onChange={(e) => {
              setText(e.target.value)
              setState((s) => ({ busy: s.busy }))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="box-foot">
            <span className="hints">
              <kbd>⏎</kbd> save <kbd>⇧⏎</kbd> new line <kbd>/</kbd> brain
            </span>
            <span className="grow" />
            {state.sent && !text && <span role="status">Saved as {id.who}</span>}
            <button type="button" className="btn primary" disabled={!text.trim() || state.busy} onClick={() => void submit()}>
              {state.busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- bottom panel ----------

function BottomPanel({ live, now, onSelect }: { live: Live; now: number; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<'claims' | 'captures'>('claims')
  const [shut, setShut] = useState(false)
  const claims = live.tasks.filter((t) => t.status === 'claimed')
  return (
    <section className={shut ? 'panel shut' : 'panel'}>
      <div className="ptabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'claims'} onClick={() => { setTab('claims'); setShut(false) }}>Open claims</button>
        <button type="button" role="tab" aria-selected={tab === 'captures'} onClick={() => { setTab('captures'); setShut(false) }}>Captures</button>
        <button type="button" className="collapse" aria-label={shut ? 'Open panel' : 'Close panel'} onClick={() => setShut(!shut)}>
          {shut ? '▴' : '▾'}
        </button>
      </div>
      {!shut && (
        <div className="panel-body">
          {tab === 'claims' &&
            (claims.length ? (
              <table>
                <thead>
                  <tr><th>Task</th><th>Owner</th><th>Side</th><th>Paths</th><th>Claimed</th></tr>
                </thead>
                <tbody>
                  {claims.map((t) => (
                    <tr key={t.id}>
                      <td className="t"><button type="button" className="text-btn" onClick={() => onSelect(t.id)}>{t.title}</button></td>
                      <td><span className="who"><Mark agent={t.owner} size={14} />{agentName(t.owner)}</span></td>
                      <td>{t.side}</td>
                      <td>{t.paths.length}</td>
                      <td>{ago(t.created_at, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pane-empty">No open claims. Nobody is holding any files.</p>
            ))}
          {tab === 'captures' &&
            (live.captures.length ? (
              <table>
                <thead>
                  <tr><th>Who</th><th>Type</th><th>State</th><th>To searchable</th><th>Received</th></tr>
                </thead>
                <tbody>
                  {live.captures.map((c) => (
                    <tr key={c.capture_id}>
                      <td>{agentName(c.who)}</td>
                      <td>{c.type}</td>
                      <td className={c.state === 'failed' ? 'bad' : ''}>{c.error ?? CAPTURE_LABEL[c.state]}</td>
                      <td>{formatMs(c.ms_to_searchable)}</td>
                      <td>{clock(c.received_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="pane-empty">Captures made while this page is open appear here, with the time each took to become searchable.</p>
            ))}
        </div>
      )}
    </section>
  )
}

// ---------- right pane ----------

function ItemRow({ kind, who, source, at, text, prov, used }: { kind: string; who: string; source?: string; at: string; text: string; prov?: string; used?: boolean }) {
  return (
    <article className={used ? 'item used' : 'item'}>
      <div className="k">
        <span className={kind === 'blocker' ? 'kind blk' : 'kind'}>{kind}</span>· {agentName(who)}
        {source ? ` · ${source}` : ''} · {clock(at)}
      </div>
      <p>{text}</p>
      {prov && <span className="prov">{prov}</span>}
    </article>
  )
}

const itemRow = (i: ItemDoc, used?: boolean) => (
  <ItemRow key={i.id} kind={i.kind} who={i.who} at={i.at} text={i.text} used={used} prov={i.raw_ids.length ? `from ${i.raw_ids.length} ${i.raw_ids.length === 1 ? 'capture' : 'captures'}` : undefined} />
)
const rawRow = (d: RawDoc, used?: boolean) => (
  <ItemRow key={d.id} kind={d.type} who={d.who} at={d.at} text={d.text} used={used} prov={d.source_ref} />
)

function Brain({ live, team, task }: { live: Live; team: string; task: TaskDoc | undefined }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; mode: string; ms: number } | { q: string; error: string } | null>(null)

  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setFound(null)
      return
    }
    let dead = false
    const t = window.setTimeout(() => {
      searchBrain(team, query)
        .then((r) => !dead && setFound({ q: query, hits: r.hits, mode: r.mode, ms: r.took_ms }))
        .catch((e: unknown) => {
          console.error('brain search failed', e)
          if (!dead) setFound({ q: query, error: e instanceof Error ? e.message : 'Search failed.' })
        })
    }, 250)
    return () => {
      dead = true
      window.clearTimeout(t)
    }
  }, [q, team])

  const written = task ? live.docs.filter((d) => d.who === task.owner && !d.source_ref?.startsWith('task:')) : []
  const searching = q.trim() && (!found || found.q !== q.trim())

  return (
    <>
      <label className="search">
        <input value={q} placeholder="What did we decide about…" aria-label="Search the brain" onChange={(e) => setQ(e.target.value)} />
        <kbd>/</kbd>
      </label>
      {q.trim() ? (
        <>
          <div className="sec">
            <span>RESULTS</span>
            <span>{found && 'hits' in found ? `${found.hits.length} · ${found.mode} · ${found.ms} ms` : ''}</span>
          </div>
          {searching && <p className="pane-empty" role="status">Searching…</p>}
          {found && 'error' in found && <p className="pane-empty bad" role="alert">Search failed: {found.error}</p>}
          {found && 'hits' in found && !searching && !found.hits.length && <p className="pane-empty">Nothing in the brain matches “{found.q}”.</p>}
          {found && 'hits' in found && found.hits.map((h) => (h.layer === 'item' ? itemRow(h.doc) : rawRow(h.doc)))}
        </>
      ) : (
        <>
          {task && (
            <>
              <div className="sec">
                <span>WRITTEN BY {agentName(task.owner).toUpperCase()}</span>
                <span>{written.length}</span>
              </div>
              {written.map((d) => rawRow(d, true))}
              {!written.length && <p className="pane-empty">{agentName(task.owner)} has not added anything to the brain.</p>}
            </>
          )}
          <div className="sec">
            <span>DECISIONS AND ITEMS</span>
            <span>{live.items.length}</span>
          </div>
          {live.items.map((i) => itemRow(i))}
          {live.status === 'ready' && !live.items.length && <p className="pane-empty">No items yet. The librarian extracts decisions, todos and questions from captures.</p>}
          <div className="sec">
            <span>LATEST</span>
            <span>{live.docs.length}</span>
          </div>
          {live.docs.slice(0, 40).map((d) => rawRow(d))}
          {live.status === 'ready' && !live.docs.length && <p className="pane-empty">Nothing captured yet.</p>}
        </>
      )}
    </>
  )
}

function Files({ tasks }: { tasks: TaskDoc[] }) {
  if (!tasks.length) return <p className="pane-empty">No files are claimed right now.</p>
  return (
    <>
      {tasks.map((t) => (
        <div key={t.id}>
          <div className="sec">
            <span>{agentName(t.owner).toUpperCase()}</span>
            <span>{TASK_LABEL[t.status].toLowerCase()}</span>
          </div>
          <ul className="files">
            {t.paths.map((p) => (
              <li key={p}>
                <span className="file-row"><Mark agent={t.owner} size={14} /><span className="fpath">{p}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}
