import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/bricolage-grotesque/800.css'
import './ade.css'
import { armAudio, playChime } from './chime'
import { board, type BrainEntry, brain, type Ev, type FileChange, people, queue, type RunState, type Session, seedSessions } from './data'
import { Mark, type MarkMode, ThemeCtx } from './Mark'
import { type Command, FreezeClock, MenuIcon, Palette, PaneIcon, Prose, STATE_LABEL, StatusGlyph, ThemeIcon, useTheme } from './parts'

// The sample ADE: scripted sessions for design and demo, shown only when VITE_SEED=true and labeled in the UI.

// ---------- small pieces ----------

/** How the agent's mark behaves for each state. It only moves for running and needs-you. */
const MARK_MODE: Record<RunState, MarkMode> = {
  running: 'working',
  needs_input: 'waiting',
  queued: 'idle',
  done: 'still',
  failed: 'still',
  cancelled: 'still',
}

// Sample ids are fixed in data.ts, so a lookup always hits.
const entry = (id: string): BrainEntry => brain[id] as BrainEntry

const unreviewed = (s: Session) =>
  s.state === 'done' && s.changes.some((c) => !s.reviewed.includes(c.path) && !s.reviewed.includes('*'))

function rank(s: Session) {
  if (s.state === 'needs_input') return 0
  if (s.state === 'failed') return 1
  if (unreviewed(s)) return 2
  if (s.state === 'running') return 3
  if (s.state === 'queued') return 4
  return 5
}

function Lines({ file, one }: { file: FileChange; one?: boolean }) {
  return (
    <>
      {file.hunks.map((h) => {
        let [a, b] = h.start
        return (
          <div key={h.header}>
            <div className="hunk-head">{h.header}</div>
            {h.lines.map((l, i) => {
              const left = l.k === '+' ? '' : a++
              const right = l.k === '-' ? '' : b++
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and can repeat
                <div key={i} className={l.k === '+' ? 'ln a' : l.k === '-' ? 'ln d' : 'ln'}>
                  {one ? <span className="no">{l.k === '-' ? left : right}</span> : <span className="no">{left}</span>}
                  {!one && <span className="no">{right}</span>}
                  <span className="sg">{l.k}</span>
                  <span className="cd">{l.text}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </>
  )
}

let nextId = 100
const uid = () => `n${nextId++}`

type RightTab = 'changes' | 'brain' | 'plan'

// ---------- page ----------

export function AdePage() {
  const [sessions, setSessions] = useState<Session[]>(seedSessions)
  const [activeId, setActiveId] = useState('s1')
  const { theme, flip } = useTheme()
  const [tab, setTab] = useState<RightTab>('changes')
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [focusEntry, setFocusEntry] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [queued, setQueued] = useState<Record<string, string>>({})
  const [stopping, setStopping] = useState<Record<string, boolean>>({})
  const [widths, setWidths] = useState({ left: 256, right: 340 })
  const [side, setSide] = useState<'none' | 'left' | 'right'>('none')
  const timers = useRef<Record<string, number[]>>({})
  const queuedRef = useRef(queued)
  queuedRef.current = queued

  const active = (sessions.find((s) => s.id === activeId) ?? sessions[0]) as Session
  const ordered = useMemo(() => [...sessions].sort((a, b) => rank(a) - rank(b)), [sessions])
  const needsYou = sessions.filter((s) => s.state === 'needs_input').length
  const working = sessions.filter((s) => s.state === 'running').length

  useEffect(armAudio, [])
  useEffect(() => {
    document.title = needsYou ? `(${needsYou}) JAM` : 'JAM'
  }, [needsYou])

  const patch = useCallback((id: string, fn: (s: Session) => Session) => {
    setSessions((all) => all.map((s) => (s.id === id ? fn(s) : s)))
  }, [])

  const push = useCallback(
    (id: string, ev: Ev, state?: RunState) => {
      patch(id, (s) => ({
        ...s,
        events: [...s.events.filter((e) => !(e.t === 'agent' && e.thinking)), ev],
        state: state ?? s.state,
        updated: 'now',
      }))
    },
    [patch],
  )

  // Every scripted step is a step boundary, so a queued steer lands here first.
  const later = useCallback(
    (id: string, ms: number, fn: () => void) => {
      const t = window.setTimeout(() => {
        const text = queuedRef.current[id]
        if (text) {
          setQueued(({ [id]: _sent, ...rest }) => rest)
          push(id, { t: 'steer', id: uid(), text })
        }
        fn()
      }, ms)
      timers.current[id] = [...(timers.current[id] ?? []), t]
    },
    [push],
  )

  // A scripted run, so the shell can be felt before the agent runner exists.
  const run = useCallback(
    (id: string, prompt: string) => {
      const q = prompt.split(/\s+/).slice(0, 3).join(' ').toLowerCase()
      const thinking = (): Ev => ({ t: 'agent', id: uid(), text: '', thinking: true })
      push(id, thinking(), 'running')
      later(id, 900, () => {
        patch(id, (s) => ({ ...s, context: [...s.context, { query: q, entries: ['b1', 'b6'], files: [] }] }))
        push(id, { t: 'tool', id: uid(), verb: 'Searched brain', target: q, result: '2 entries', ok: true })
        push(id, thinking())
      })
      later(id, 2400, () => {
        push(id, { t: 'tool', id: uid(), verb: 'Read', target: 'packages/shared/src/types.ts', result: '214 lines', ok: true })
        push(id, thinking())
      })
      later(id, 4200, () => {
        push(
          id,
          {
            t: 'agent',
            id: uid(),
            text: 'This is a sample run: the shell is local and no agent is attached yet. A real reply will state what changed, what was verified and what was not.',
            cites: ['b1', 'b6'],
          },
          'done',
        )
        playChime('done')
      })
    },
    [later, patch, push],
  )

  const send = useCallback(
    (text: string) => {
      const s = active
      if (s.state === 'running') {
        setQueued((q) => ({ ...q, [s.id]: text }))
        return
      }
      push(s.id, { t: 'user', id: uid(), who: 'jake', text })
      run(s.id, text)
    },
    [active, push, run],
  )

  const sendQueuedNow = useCallback(() => {
    const text = queued[active.id]
    if (!text) return
    setQueued(({ [active.id]: _sent, ...rest }) => rest)
    push(active.id, { t: 'steer', id: uid(), text })
  }, [active.id, push, queued])

  const stop = useCallback(() => {
    const id = active.id
    if (active.state !== 'running' || stopping[id]) return
    setStopping((m) => ({ ...m, [id]: true }))
    for (const t of timers.current[id] ?? []) window.clearTimeout(t)
    timers.current[id] = []
    window.setTimeout(() => {
      push(id, { t: 'note', id: uid(), text: 'Stopped by jake. Nothing was committed.' }, 'cancelled')
      setStopping((m) => ({ ...m, [id]: false }))
    }, 600)
  }, [active.id, active.state, push, stopping])

  const answer = useCallback(
    (evId: string, option: string) => {
      const id = active.id
      patch(id, (s) => ({
        ...s,
        events: s.events.map((e) => (e.id === evId && e.t === 'ask' ? { ...e, answer: option } : e)),
      }))
      run(id, option)
    },
    [active.id, patch, run],
  )

  const newSession = useCallback(() => {
    const id = uid()
    setSessions((all) => [
      { id, title: 'New session', agent: 'sonnet-1', model: 'Sonnet 5.5', owner: 'jake', branch: 'not started', stream: 'B · UI', tokens: '0', state: 'queued', updated: 'now', events: [], changes: [], context: [], plan: [], reviewed: [] },
      ...all,
    ])
    setActiveId(id)
    setOpenFile(null)
  }, [])

  const select = useCallback((id: string) => {
    setActiveId(id)
    setOpenFile(null)
    setFocusEntry(null)
    setSide('none')
  }, [])

  const nextNeedsYou = useCallback(() => {
    const list = ordered.filter((s) => s.state === 'needs_input' || s.state === 'failed')
    if (!list.length) return
    const i = list.findIndex((s) => s.id === activeId)
    const next = list[(i + 1) % list.length]
    if (next) select(next.id)
  }, [activeId, ordered, select])

  const show = useCallback((t: RightTab) => {
    setTab(t)
    setOpenFile(null)
    setSide('right')
  }, [])

  const cite = useCallback((entryId: string) => {
    setTab('brain')
    setFocusEntry(entryId)
    setSide('right')
  }, [])

  const openDiff = useCallback((path: string) => {
    setTab('changes')
    setOpenFile(path)
    setSide('right')
  }, [])

  const toggleReviewed = useCallback(
    (path: string) => {
      patch(active.id, (s) => ({
        ...s,
        reviewed: s.reviewed.includes(path) ? s.reviewed.filter((p) => p !== path) : [...s.reviewed, path],
      }))
    },
    [active.id, patch],
  )

  // Keyboard: Cmd-K palette, Option-Space capture, Esc stops, j/k sessions, / brain search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (e.altKey && e.code === 'Space') {
        e.preventDefault()
        window.location.assign('/c')
        return
      }
      if (palette) return
      if (e.key === 'Escape') {
        if (openFile) setOpenFile(null)
        else stop()
        return
      }
      const el = e.target as HTMLElement
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        show('brain')
        window.setTimeout(() => document.querySelector<HTMLInputElement>('.ade .search input')?.focus(), 0)
      }
      if (e.key === 'j' || e.key === 'k') {
        const i = ordered.findIndex((s) => s.id === activeId)
        const next = ordered[Math.min(ordered.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))]
        if (next) select(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, openFile, ordered, palette, select, show, stop])

  const drag = (which: 'left' | 'right') => (e: React.PointerEvent) => {
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
    { label: 'New session', hint: 'Start an agent on a task', run: newSession },
    { label: 'Jump to next that needs you', hint: `${needsYou} waiting`, run: nextNeedsYou },
    { label: 'Stop this session', hint: 'Esc', run: stop },
    { label: 'Open changes', run: () => show('changes') },
    { label: 'Search the brain', hint: '/', run: () => show('brain') },
    { label: 'Open plan', run: () => show('plan') },
    { label: theme === 'dark' ? 'Switch to light' : 'Switch to dark', run: flip },
    { label: 'Capture a voice note', hint: '⌥Space', run: () => window.location.assign('/c') },
    ...ordered.map((s) => ({ label: s.title, hint: `${s.agent} · ${STATE_LABEL[s.state]}`, agent: s.agent, run: () => select(s.id) })),
  ]

  const file = active.changes.find((c) => c.path === openFile) ?? null
  const used = active.context.reduce((n, c) => n + c.entries.length, 0)

  return (
    <ThemeCtx.Provider value={theme}>
      <div
        className="ade"
        data-side={side}
        style={{ '--w-left': `${widths.left}px`, '--w-right': `${widths.right}px` } as React.CSSProperties}
      >
        <header className="bar">
          <button type="button" className="icon only-narrow" aria-label="Sessions" onClick={() => setSide(side === 'left' ? 'none' : 'left')}>
            <MenuIcon />
          </button>
          <Mark agent="jam" size={22} />
          <span className="wm">JAM</span>
          <span className="crumb">cnh-jam / <b>main</b></span>
          <button type="button" className="cmd" onClick={() => setPalette(true)}>
            <span>Search sessions and commands</span>
            <kbd>⌘K</kbd>
          </button>
          <FreezeClock />
          <button type="button" className="talk" onClick={() => window.location.assign('/c')}>
            <i />
            Capture <kbd>⌥Space</kbd>
          </button>
          <button type="button" className="icon" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={flip}>
            <ThemeIcon theme={theme} />
          </button>
          <button type="button" className="icon only-narrow" aria-label="Review pane" onClick={() => setSide(side === 'right' ? 'none' : 'right')}>
            <PaneIcon />
          </button>
        </header>

        <nav className="left" aria-label="Sessions">
          <div className="sec">
            <span>SESSIONS</span>
            <span>{needsYou ? `${needsYou} need you` : `${working} working`}</span>
          </div>
          <ul className="sessions">
            {ordered.map((s) => (
              <li key={s.id}>
                <button type="button" className="session" aria-current={s.id === active.id} onClick={() => select(s.id)}>
                  <Mark agent={s.agent} size={28} mode={MARK_MODE[s.state]} />
                  <span className="s-title">{s.title}</span>
                  <span className="s-time">{s.updated}</span>
                  <span className="s-meta">
                    {s.state === 'needs_input' || s.state === 'failed' ? (
                      <b className={`s-flag s-${s.state}`}>{STATE_LABEL[s.state]}</b>
                    ) : unreviewed(s) ? (
                      <b className="s-flag">Review</b>
                    ) : (
                      STATE_LABEL[s.state]
                    )}
                    {' · '}
                    {s.agent} · {s.owner}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="newag" onClick={newSession}>+ New session</button>
          <div className="sec">
            <span>PEOPLE</span>
            <span>{people.length}</span>
          </div>
          {people.map((p) => (
            <div key={p.name} className="hu">
              <span className="av">{p.name.charAt(0).toUpperCase()}</span>
              {p.name}
              <span className="s">{p.name === 'jake' ? `viewing ${active.agent}` : p.doing}</span>
            </div>
          ))}
          <span className="grow" />
          <div className="left-foot"><kbd>j</kbd> <kbd>k</kbd> move between sessions</div>
        </nav>
        <div className="divider d-left" onPointerDown={drag('left')} />

        <main className="center">
          <div className="path">
            <StatusGlyph state={active.state} />
            <span className="t-title">{active.title}</span>
            <span>stream <b>{active.stream}</b></span>
            <span>branch <b>{active.branch}</b></span>
            {active.pr && <span>PR <b>#{active.pr}</b></span>}
            <span>model <b>{active.model}</b></span>
          </div>
          <Transcript session={active} onCite={cite} onAnswer={answer} onOpenFile={openDiff} />
          <Composer
            key={active.id}
            session={active}
            queued={queued[active.id]}
            stopping={!!stopping[active.id]}
            onSend={send}
            onStop={stop}
            onSendNow={sendQueuedNow}
            onOpenFile={openDiff}
          />
          <BottomPanel />
        </main>
        <div className="divider d-right" onPointerDown={drag('right')} />

        <aside className="right" aria-label="Review">
          <div className="tabs" role="tablist">
            {(
              [
                ['changes', 'Changes', active.changes.length],
                ['brain', 'Brain', used],
                ['plan', 'Plan', active.plan.length],
              ] as const
            ).map(([id, label, n]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setOpenFile(null) }}>
                {label}
                {n > 0 && <span className="count">{n}</span>}
              </button>
            ))}
          </div>
          <div className="right-body">
            {tab === 'changes' &&
              (file ? (
                <Diff file={file} reviewed={active.reviewed.includes(file.path)} onBack={() => setOpenFile(null)} onReviewed={() => toggleReviewed(file.path)} />
              ) : (
                <Changes session={active} onOpen={setOpenFile} />
              ))}
            {tab === 'brain' && <Brain session={active} focus={focusEntry} />}
            {tab === 'plan' && <Plan session={active} />}
          </div>
        </aside>

        <footer className="sb">
          <span><b>main</b> ↑2</span>
          <span>{queue.filter((q) => q.status !== 'merged').length} PRs open</span>
          <span>{working} working</span>
          <span className={needsYou ? 'need' : ''}>{needsYou} need you</span>
          <span className="sp" />
          <span className="sample">sample data</span>
          <span>local</span>
        </footer>

        {side !== 'none' && <button type="button" className="scrim" aria-label="Close pane" onClick={() => setSide('none')} />}
        {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      </div>
    </ThemeCtx.Provider>
  )
}

// ---------- transcript ----------

type ThreadProps = { onCite: (id: string) => void; onAnswer: (ev: string, o: string) => void; onOpenFile: (p: string) => void }

function Transcript({ session, ...on }: { session: Session } & ThreadProps) {
  const box = useRef<HTMLDivElement>(null)
  const count = session.events.length
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the session, its event count or its state changes
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.id, count, session.state])

  if (!count)
    return (
      <div className="transcript empty">
        <p>Nothing has run here yet.</p>
        <p className="dim">Describe the task below. The agent reads the team brain first and shows which entries it used.</p>
      </div>
    )

  return (
    <div className="transcript" ref={box}>
      <div className="col">
        {session.events.map((e) => (
          <Event key={e.id} e={e} session={session} {...on} />
        ))}
        {session.state === 'queued' && <p className="note">Queued. Starts when {session.agent} is free.</p>}
      </div>
    </div>
  )
}

function Human({ who, at, text }: { who: string; at?: string; text: string }) {
  return (
    <div className="ev human">
      <span className="av">{who.charAt(0).toUpperCase()}</span>
      <div>
        <small>{at ? `${who} · ${at}` : who}</small>
        <Prose text={text} />
      </div>
    </div>
  )
}

function Event({ e, session, onCite, onAnswer, onOpenFile }: { e: Ev; session: Session } & ThreadProps) {
  // Brain searches open by default: what the agent knew is the point.
  const entries = e.t === 'tool' ? session.context.find((c) => c.query === e.target)?.entries : undefined
  const change = e.t === 'tool' ? session.changes.find((c) => c.path === e.target) : undefined
  const [open, setOpen] = useState(!!entries)

  switch (e.t) {
    case 'user':
      return <Human who={e.who} at={e.at} text={e.text} />
    case 'steer':
      return <Human who="jake" at="steer" text={e.text} />
    case 'agent':
      if (e.thinking)
        return (
          <div className="ev thinking" role="status">
            <Mark agent={session.agent} size={18} mode="working" />
            <span>Working<i /><i /><i /></span>
          </div>
        )
      return (
        <div className="ev say">
          <Mark agent={session.agent} size={18} />
          <div>
            <Prose text={e.text} />
            {e.cites && (
              <div className="cites">
                <span>From the brain</span>
                {e.cites.map((id) => (
                  <button key={id} type="button" className="chip" onClick={() => onCite(id)} title={entry(id).text}>
                    {entry(id).who} · {entry(id).source} · {entry(id).at}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )
    case 'tool': {
      const body = entries || change || e.detail
      return (
        <div className={e.ok ? 'ev call' : 'ev call bad'}>
          <button type="button" className="row" aria-expanded={open} disabled={!body} onClick={() => setOpen(!open)}>
            <span className="t">{body ? (open ? '▾' : '▸') : '·'}</span>
            <span className="tool">{e.verb}</span>
            <span className="t target">{entries ? `"${e.target}"` : e.target}</span>
            <span className="ok">{e.result}</span>
          </button>
          {open && entries && (
            <div className="body">
              {entries.map((id) => (
                <div key={id} className="bq">
                  <div className="k">{entry(id).kind.toUpperCase()} · {entry(id).who} · {entry(id).source} · {entry(id).at}</div>
                  <q>“{entry(id).text}”</q>
                </div>
              ))}
            </div>
          )}
          {open && !entries && change && (
            <div className="body">
              <div className="edit one">
                <div className="fh">
                  <span>{change.path}</span>
                  <button type="button" className="text-btn st" onClick={() => onOpenFile(change.path)}>Review</button>
                </div>
                <Lines file={change} one />
              </div>
            </div>
          )}
          {open && !entries && !change && e.detail && (
            <div className="body">
              <pre>{e.detail}</pre>
            </div>
          )}
        </div>
      )
    }
    case 'ask':
      return (
        <div className={e.answer ? 'ev ask answered' : 'ev ask'}>
          <span className="who">{e.answer ? 'Answered' : 'Needs you'}</span>
          <Prose text={e.text} />
          <div className="options">
            {e.options.map((o) => (
              <button key={o} type="button" className={e.answer === o ? 'btn chosen' : 'btn'} disabled={!!e.answer || session.state !== 'needs_input'} onClick={() => onAnswer(e.id, o)}>
                {o}
              </button>
            ))}
          </div>
        </div>
      )
    case 'note':
      return <p className="note">{e.text}</p>
  }
}

// ---------- composer ----------

function Composer(props: {
  session: Session
  queued?: string
  stopping: boolean
  onSend: (t: string) => void
  onStop: () => void
  onSendNow: () => void
  onOpenFile: (p: string) => void
}) {
  const { session, queued, stopping } = props
  const [text, setText] = useState('')
  const running = session.state === 'running'
  const submit = () => {
    const t = text.trim()
    if (!t) return
    props.onSend(t)
    setText('')
  }
  return (
    <div className="composer">
      <div className="col">
        {session.changes.length > 0 && (
          <div className="changed">
            <span>{session.changes.length} changed</span>
            {session.changes.map((c) => (
              <button key={c.path} type="button" onClick={() => props.onOpenFile(c.path)}>
                {c.path.split('/').pop()} <em>+{c.add} −{c.del}</em>
              </button>
            ))}
          </div>
        )}
        {queued && (
          <div className="queued">
            <span className="dim">Will send at the next step</span>
            <span className="q-text">{queued}</span>
            <button type="button" className="text-btn" onClick={props.onSendNow}>Send now</button>
          </div>
        )}
        <div className="box">
          <textarea
            rows={2}
            value={text}
            placeholder={running ? `Steer ${session.agent} while it works` : session.state === 'needs_input' ? 'Answer above, or write your own' : `Message ${session.agent}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="box-foot">
            <span className="hints">
              {running ? (
                <>
                  <kbd>⏎</kbd> queues a steer <kbd>Esc</kbd> stops
                </>
              ) : (
                <>
                  <kbd>⏎</kbd> send <kbd>⇧⏎</kbd> new line <kbd>/</kbd> brain
                </>
              )}
            </span>
            <span className="grow" />
            {running && (
              <button type="button" className="btn" disabled={stopping} onClick={props.onStop}>
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            <button type="button" className="btn primary" disabled={!text.trim()} onClick={submit}>
              {running ? 'Steer' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- bottom panel ----------

const QUEUE_STATUS = { merged: 'merged', merging: 'merging', checks: 'checks running', changes: 'blocked' } as const
const STREAM_AGENT = { A: 'opus-1', B: 'sonnet-1', C: 'fable', D: 'opus-2' } as const

function BottomPanel() {
  const [tab, setTab] = useState<'queue' | 'board'>('queue')
  const [shut, setShut] = useState(false)
  return (
    <section className={shut ? 'panel shut' : 'panel'}>
      <div className="ptabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'queue'} onClick={() => { setTab('queue'); setShut(false) }}>Merge queue</button>
        <button type="button" role="tab" aria-selected={tab === 'board'} onClick={() => { setTab('board'); setShut(false) }}>Board</button>
        <button type="button" className="collapse" aria-label={shut ? 'Open panel' : 'Close panel'} onClick={() => setShut(!shut)}>
          {shut ? '▴' : '▾'}
        </button>
      </div>
      {!shut && (
        <div className="panel-body">
          {tab === 'queue' ? (
            <table>
              <thead>
                <tr><th>PR</th><th>Title</th><th>Author</th><th>Gitar</th><th>Status</th></tr>
              </thead>
              <tbody>
                {[...queue].reverse().map((q) => (
                  <tr key={q.number}>
                    <td>#{q.number}</td>
                    <td className="t">{q.title}</td>
                    <td>
                      <span className="who"><Mark agent={STREAM_AGENT[q.stream]} size={14} />{STREAM_AGENT[q.stream]}</span>
                    </td>
                    <td className={q.status === 'changes' ? 'bad' : ''}>{q.gitar}</td>
                    <td>{QUEUE_STATUS[q.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="board">
              {board.map((p) => (
                <li key={p.id}>
                  <span className="k">{p.who} · {new Date(p.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })}</span>
                  <p>{p.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

// ---------- right pane ----------

function Empty({ children }: { children: ReactNode }) {
  return <p className="pane-empty">{children}</p>
}

function Changes({ session, onOpen }: { session: Session; onOpen: (p: string) => void }) {
  if (!session.changes.length) return <Empty>No files changed in this session.</Empty>
  const done = session.changes.filter((c) => session.reviewed.includes(c.path)).length
  return (
    <>
      <div className="sec">
        <span>CHANGED FILES</span>
        <span>{done} of {session.changes.length} reviewed</span>
      </div>
      <ul className="files">
        {session.changes.map((c) => (
          <li key={c.path}>
            <button type="button" onClick={() => onOpen(c.path)}>
              <span className={session.reviewed.includes(c.path) ? 'tick on' : 'tick'} />
              <span className="fpath">{c.path}</span>
              <em>+{c.add} −{c.del}</em>
            </button>
          </li>
        ))}
      </ul>
      <div className="sec">
        <span>EVIDENCE</span>
        <span>0</span>
      </div>
      <Empty>No test output or screenshot is attached to this run.</Empty>
    </>
  )
}

function Diff({ file, reviewed, onBack, onReviewed }: { file: FileChange; reviewed: boolean; onBack: () => void; onReviewed: () => void }) {
  return (
    <div className="diff">
      <div className="diff-head">
        <button type="button" className="text-btn" onClick={onBack}>← Files</button>
        <span className="fpath">{file.path}</span>
        <button type="button" className={reviewed ? 'btn chosen' : 'btn'} onClick={onReviewed}>
          {reviewed ? 'Reviewed' : 'Mark reviewed'}
        </button>
      </div>
      <div className="edit">
        <Lines file={file} />
      </div>
    </div>
  )
}

function Item({ id, used, focus }: { id: string; used?: boolean; focus?: boolean }) {
  const e = entry(id)
  return (
    <article className={`item${used ? ' used' : ''}${focus ? ' focus' : ''}`}>
      <div className="k">
        <span className={e.kind === 'blocker' ? 'kind blk' : 'kind'}>{e.kind}</span>· {e.who} · {e.source} · {e.at}
      </div>
      <p>{e.text}</p>
      <span className="prov">{e.ref}</span>
    </article>
  )
}

function Brain({ session, focus }: { session: Session; focus: string | null }) {
  const [q, setQ] = useState('')
  const usedIds = [...new Set(session.context.flatMap((c) => c.entries))]
  const match = (id: string) => `${entry(id).text} ${entry(id).who} ${entry(id).kind}`.toLowerCase().includes(q.toLowerCase())
  const latest = Object.keys(brain)
    .filter((id) => !usedIds.includes(id))
    .sort((a, b) => entry(b).at.localeCompare(entry(a).at))
    .filter(match)
  const used = usedIds.filter(match)
  return (
    <>
      <label className="search">
        <input value={q} placeholder="What did we decide about…" aria-label="Search the brain" onChange={(e) => setQ(e.target.value)} />
        <kbd>/</kbd>
      </label>
      <div className="sec">
        <span>USED BY {session.agent.toUpperCase()}</span>
        <span>{used.length}</span>
      </div>
      {used.map((id) => (
        <Item key={id} id={id} used focus={focus === id} />
      ))}
      {!usedIds.length && <Empty>This run has not read from the brain yet.</Empty>}
      <div className="sec">
        <span>LATEST</span>
        <span>{latest.length}</span>
      </div>
      {latest.map((id) => (
        <Item key={id} id={id} />
      ))}
    </>
  )
}

function Plan({ session }: { session: Session }) {
  if (!session.plan.length) return <Empty>No plan yet.</Empty>
  const at = session.plan.findIndex((p) => !p.done)
  return (
    <ol className="plan">
      {session.plan.map((p, i) => (
        <li key={p.text} className={p.done ? 'done' : i === at ? 'now' : ''}>
          <span className="n">{i + 1}</span>
          {p.text}
        </li>
      ))}
    </ol>
  )
}
