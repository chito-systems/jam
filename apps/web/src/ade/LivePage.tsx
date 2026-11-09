import type { AgentDoc, CaptureStatus, ChaosState, ItemDoc, ItemVerdict, OwnershipMapResponse, RawDoc, SearchHit, TaskDoc } from '@hh/shared'
import { type CSSProperties, createContext, type FormEvent, type ReactNode, type PointerEvent as ReactPointerEvent, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/bricolage-grotesque/800.css'
import './ade.css'
import { agentMode, foldGone, groupAgents, ownerLabel, shortName } from './agents'
import { armAudio, playChime, setSound, soundOn } from './chime'
import type { RunState } from './data'
import { Guide, guideSeen, HelpIcon } from './Guide'
import { addNote, agentName, ago, captainsOf, clock, decisionLogUrl, formatMs, type Identity, isAgent, itemNewer, type Live, loadIdentity, loadOwnership, loadRecent, type Member, member, mergeSaid, newlyDone, pct, pendingCaptures, roster, sameWho, saveIdentity, searchBrain, setVerdict, threadFor, useLive } from './live'
import { Mark, type MarkMode, ThemeCtx } from './Mark'
import { orderFor, proposedOrders, setChaos, workTasks } from './orders'
import { type Command, FreezeClock, MenuIcon, Palette, PaneIcon, Prose, SoundIcon, StatusGlyph, ThemeIcon, useTheme } from './parts'
import { type Outgoing, Talk } from './Talk'
import { Terminal } from './Terminal'
import { TabStrip, TermStack, useTermTabs } from './TermTabs'
import { clampPanel, loadPanelHeight, savePanelHeight } from './term'
import { WorkOrder } from './WorkOrder'
import { JamView } from './JamView'
import { assignedOrders, myAgents, needsHuman, personNow, railPeople, unregistered } from './rail'

// The ADE on real data. The API has tasks, brain entries, captures and stats; it has no
// agent transcripts yet, so a "session" here is a task claim and what the brain holds about it.

const FEED = 'feed'
/** The jam view: what the shared librarian proposed, needs confirmed, and assigned. */
const JAM = 'jam'
/** activeId for a person from the people list: `person:<who>`. */
const PERSON = 'person:'
const TASK_STATE: Record<TaskDoc['status'], RunState> = { proposed: 'needs_input', claimed: 'running', done: 'done', released: 'cancelled' }
const TASK_LABEL: Record<TaskDoc['status'], string> = { proposed: 'Proposed', claimed: 'Working', done: 'Done', released: 'Released' }
const TASK_MARK: Record<TaskDoc['status'], MarkMode> = { proposed: 'waiting', claimed: 'working', done: 'still', released: 'idle' }
// What the chaos switch does, from the API (chaos-routes.ts and the ChaosState contract).
const CHAOS_TEXT = 'CHAOS on: indexing waits 3 s and fails 20% of the time'
const LATEST_MAX = 40
const CAPTURE_LABEL: Record<CaptureStatus['state'], string> = {
  queued: 'queued',
  transcribing: 'transcribing',
  indexing: 'indexing',
  indexed: 'searchable',
  failed: 'failed',
}

type RightTab = 'brain' | 'files'

/** Turns an owner like "agent:cam-opus-1" into "opus-1 · cam" once /api/agents knows it. */
const NameCtx = createContext<(who: string) => string>(agentName)
const AGENT_STATE: Record<AgentDoc['state'], string> = { active: 'active', idle: 'idle', gone: 'gone' }
/** "just now", or "4m ago". */
const seen = (iso: string, now: number) => {
  const a = ago(iso, now)
  return a === 'now' ? 'just now' : `${a} ago`
}

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
  const known = useMemo(() => new Map(live.agents.map((a) => [a.id, a])), [live.agents])
  const owner = useCallback((who: string) => ownerLabel(who, known), [known])

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
    setFinished(`${owner(t.owner)} finished: ${t.title}`)
  }, [live.status, live.tasks, owner])
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

  const orders = useMemo(() => proposedOrders(live.tasks), [live.tasks])
  const tasks = useMemo(() => workTasks(live.tasks), [live.tasks])
  const active = live.tasks.find((t) => t.id === activeId)
  const proposed = active?.status === 'proposed' ? active : undefined
  const open = tasks.filter((t) => t.status === 'claimed')
  const order = useMemo(() => [FEED, ...orders.map((t) => t.id), ...tasks.map((t) => t.id)], [orders, tasks])
  const [chaosAsk, setChaosAsk] = useState<ChaosAsk>(null)

  const term = useTermTabs(id.who, id.team, live.agents)
  const { show: showTab, focusAgent } = term
  const select = useCallback((next: string) => {
    setActiveId(next)
    setSide('none')
    showTab(null)
  }, [showTab])
  // An agent in the rail with an open terminal here goes to that tab; otherwise its detail view.
  const pick = useCallback((next: string) => {
    if (focusAgent(next)) setSide('none')
    else select(next)
  }, [focusAgent, select])

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
    { label: 'Open the decision log', hint: 'markdown', run: () => window.open(decisionLogUrl(id.team), '_blank', 'noopener') },
    { label: live.stats?.chaos ? 'Turn chaos off' : 'Turn chaos on', hint: 'demo', run: () => setChaosAsk(live.stats?.chaos ? 'off' : 'on') },
    { label: 'Team feed', run: () => select(FEED) },
    { label: theme === 'dark' ? 'Switch to light' : 'Switch to dark', run: flip },
    { label: 'Open the setup guide', run: () => setGuide(true) },
    { label: 'Change team or name', hint: `${id.team} · ${id.who}`, run: onSignOut },
    ...orders.map((t) => ({ id: t.id, label: t.title, hint: `work order · for ${orderFor(t)}`, agent: 'jam', run: () => select(t.id) })),
    ...tasks.map((t) => ({ id: t.id, label: t.title, hint: `${owner(t.owner)} · ${TASK_LABEL[t.status]}`, agent: t.owner, run: () => select(t.id) })),
  ]

  const crew = useMemo(() => groupAgents(live.stats?.by_who ?? {}, live.agents), [live.stats?.by_who, live.agents])
  const [own, setOwn] = useState<{ map?: OwnershipMapResponse; error?: string }>({})
  useEffect(() => {
    let dead = false
    setOwn({})
    loadOwnership(id.team)
      .then((map) => !dead && setOwn({ map }))
      .catch((e: unknown) => {
        console.error('loading side ownership failed', e)
        if (!dead) setOwn({ error: e instanceof Error ? e.message : 'The API did not answer.' })
      })
    return () => {
      dead = true
    }
  }, [id.team])
  const captains = useMemo(() => captainsOf(own.map), [own.map])
  const members = useMemo(() => roster(live.stats?.by_who ?? {}, live.tasks, live.docs, captains, live.agents), [live.stats, live.tasks, live.docs, captains, live.agents])
  const person = activeId.startsWith(PERSON) ? members.find((m) => !isAgent(m.who) && sameWho(m.who, activeId.slice(PERSON.length))) : undefined
  const agent = known.get(activeId)
  const isJam = activeId === JAM
  const pending = useMemo(() => needsHuman(live.items), [live.items])
  const assigned = useMemo(() => assignedOrders(live.tasks), [live.tasks])
  const mine = useMemo(() => myAgents(live.agents, id.who), [live.agents, id.who])
  const waitingTabs = term.list.filter((s) => s.agentName && unregistered([s.agentName], live.agents).length)
  const people = railPeople(crew.people)
  const shown = agent ? agent.claims : active ? [active] : open
  const fileCount = shown.reduce((n, t) => n + t.paths.length, 0)

  return (
    <NameCtx.Provider value={owner}>
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
        {live.stats?.chaos && <span className="chaos-tag" title={CHAOS_TEXT}>CHAOS</span>}
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
          <span>SHARED</span>
          <span />
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
          <li>
            <button type="button" className="session" aria-current={activeId === JAM} onClick={() => select(JAM)}>
              <Mark agent="jam" size={28} mode={orders.length || pending.length ? 'waiting' : undefined} />
              <span className="s-title">jam</span>
              <span className="s-time">{orders.length + pending.length > 0 && <span className="count">{orders.length + pending.length}</span>}</span>
              <span className="s-meta">Sorts the feed: proposes, asks, assigns</span>
            </button>
          </li>
        </ul>
        <div className="sec">
          <span>WORK</span>
          <span>{open.length} working</span>
        </div>
        <ul className="sessions">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="session" aria-current={t.id === activeId} onClick={() => select(t.id)}>
                <Mark agent={t.owner} size={28} mode={TASK_MARK[t.status]} />
                <span className="s-title">{t.title}</span>
                <span className="s-time">{ago(t.updated_at, now)}</span>
                <span className="s-meta">
                  {TASK_LABEL[t.status]} · {owner(t.owner)} · {t.side}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {live.status === 'ready' && !tasks.length && <p className="pane-empty">No task is claimed yet. An agent claims one with the task_claim tool, and it appears here.</p>}
        <div className="sec">
          <span>YOUR AGENTS</span>
          <span>{mine.length + waitingTabs.length || ''}</span>
        </div>
        <div className="crew">
          <AgentRows agents={mine} activeId={activeId} now={now} onSelect={pick} />
          {waitingTabs.length > 0 && (
            <ul className="ags">
              {waitingTabs.map((s) => (
                <li key={s.id}>
                  <button type="button" className="ag" aria-current={term.active === s.id} title={`${s.agentName} · starting in a terminal here`} onClick={() => term.show(s.id)}>
                    <Mark agent={`agent:${s.agentName}`} size={18} mode="idle" />
                    <span className="ag-name">{s.title}</span>
                    <span className="ag-side">{s.side ?? ''}</span>
                    <span className="a-dot a-idle" role="img" aria-label="starting" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!mine.length && !waitingTabs.length && <p className="pane-empty">No agents of yours yet.</p>}
          <button type="button" className="ag-more" disabled={term.full} onClick={() => term.newAgent()}>+ New agent</button>
        </div>
        <div className="sec">
          <span>PEOPLE</span>
          <span>{people.length || ''}</span>
        </div>
        <div className="crew">
          {people.map((p) => {
            const m = members.find((x) => !isAgent(x.who) && sameWho(x.who, p.human)) ?? member(p.human, [], [])
            const n = p.agents.length
            return <PersonRow key={p.human} who={p.human} line={`${personNow(m)}${n ? ` · ${n} ${n === 1 ? 'agent' : 'agents'}` : ''}`} active={activeId.startsWith(PERSON) && sameWho(activeId.slice(PERSON.length), p.human)} onSelect={select} />
          })}
          {!people.length && <p className="pane-empty">Nobody has said anything yet.</p>}
        </div>
        <span className="grow" />
        <div className="left-foot"><kbd>j</kbd> <kbd>k</kbd> move between tasks</div>
      </nav>
      <div className="divider d-left" onPointerDown={drag('left')} />

      <main className="center" data-term={term.active ? '' : undefined}>
        <TabStrip t={term} />
        <div className="path">
          {isJam ? (
            <>
              <span className="t-title">jam</span>
              <span>proposed <b>{orders.length}</b></span>
              <span>needs a human <b>{pending.length}</b></span>
              <span>assigned <b>{assigned.length}</b></span>
            </>
          ) : person ? (
            <>
              <span className="t-title">{person.who}</span>
              <span>side <b>{person.side ?? 'none yet'}</b></span>
              <span>working <b>{person.working.length}</b></span>
              <span>assigned <b>{person.assigned.length}</b></span>
              <span>agents <b>{person.agents.length}</b></span>
            </>
          ) : agent ? (
            <>
              <span className={`a-dot a-${agent.state}`} role="img" aria-label={AGENT_STATE[agent.state]} />
              <span className="t-title">{shortName(agent)}</span>
              {agent.human && <span>works for <b>{agent.human}</b></span>}
              {agent.side && <span>side <b>{agent.side}</b></span>}
              <span>seen <b>{ago(agent.last_seen, now)}</b></span>
            </>
          ) : proposed ? (
            <>
              <StatusGlyph state="needs_input" />
              <span className="t-title">{proposed.title}</span>
              <span>proposed by <b>jam</b></span>
              <span>for <b>{orderFor(proposed)}</b></span>
            </>
          ) : active ? (
            <>
              <StatusGlyph state={TASK_STATE[active.status]} />
              <span className="t-title">{active.title}</span>
              <span>owner <b>{owner(active.owner)}</b></span>
              <span>side <b>{active.side}</b></span>
              {active.pr && <span>PR <b>{active.pr}</b></span>}
              <span>claimed <b>{clock(active.created_at)}</b></span>
            </>
          ) : (
            <>
              <span className="t-title">Team feed</span>
              <span>entries <b>{live.stats?.raw_total ?? 0}</b></span>
              <span>items <b>{live.stats?.items_total ?? 0}</b></span>
              <a className="path-link" href={decisionLogUrl(id.team)} target="_blank" rel="noopener">decision log ↗</a>
            </>
          )}
        </div>
        {isJam ? (
          <JamView orders={orders} pending={pending} assigned={assigned} now={now} owner={owner} onOpen={select} item={(i) => <ItemCard key={i.id} item={i} id={id} />} />
        ) : person ? (
          <PersonView m={person} own={own} id={id} now={now} onSelect={select} owner={owner} />
        ) : agent ? (
          <AgentCard agent={agent} now={now} onSelect={select} onNewTerminal={term.full ? undefined : () => term.newAgent(agent.side === 'frontend' ? 'frontend' : 'backend')} />
        ) : proposed ? (
          <WorkOrder task={proposed} id={id} onPut={live.putTask} onDismissed={() => select(FEED)} />
        ) : (
          <Thread live={live} task={active} id={id} outgoing={outgoing} now={now} onSignOut={onSignOut} />
        )}
        {!proposed && !agent && !person && !isJam && <NoteBox id={id} />}
        <TermStack t={term} />
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
            {fileCount > 0 && <span className="count">{fileCount}</span>}
          </button>
        </div>
        <div className="right-body">
          {tab === 'brain' ? <Brain live={live} id={id} task={proposed ? undefined : active} /> : <Files tasks={shown} />}
        </div>
      </aside>

      <footer className="sb">
        <span><b>{id.team}</b></span>
        {live.stats?.chaos && <span className="bad sb-chaos" role="status" title={CHAOS_TEXT}>{CHAOS_TEXT}</span>}
        <span className="extra">{live.stats?.raw_total ?? 0} entries</span>
        <span className="extra">{live.stats?.items_total ?? 0} items</span>
        <span>{live.stats?.open_tasks ?? 0} open tasks</span>
        <span className="sb-done" role="status">{finished}</span>
        <span className="extra">searchable p50 <b>{formatMs(live.stats?.slo.p50_ms)}</b></span>
        <span className="sp" />
        <ChaosSwitch id={id} on={!!live.stats?.chaos} ready={!!live.stats} ask={chaosAsk} setAsk={setChaosAsk} onState={live.putChaos} />
        <button type="button" className="sb-btn" aria-label="Change team or name" title="Change team or name" onClick={onSignOut}>{id.who}</button>
        {!id.persisted && <span className="bad" role="status" title="This browser blocked storage, so the capture page will ask for your team and name again.">this tab only</span>}
        <span>{live.conn}</span>
      </footer>

      {side !== 'none' && <button type="button" className="scrim" aria-label="Close pane" onClick={() => setSide('none')} />}
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {guide && <Guide id={id} live={live} onSignOut={onSignOut} onClose={() => setGuide(false)} />}
    </div>
    </NameCtx.Provider>
  )
}

// ---------- people and agents: who is who ----------

/** A person in the rail: opens what they hold, what jam assigned them and what they're in charge of. */
function PersonRow({ who, line, active, onSelect }: { who: string; line: string; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button type="button" className="hu hu-person" aria-current={active} title={`What ${who} is doing`} onClick={() => onSelect(PERSON + who)}>
      <span className="av">{who.slice(0, 1).toUpperCase()}</span>
      <span className="hu-name">{who}</span>
      <span className="s">{line}</span>
    </button>
  )
}

function AgentRows({ agents, activeId, now, onSelect }: { agents: AgentDoc[]; activeId: string; now: number; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const { rows, folded } = foldGone(agents, open)
  if (!agents.length) return null
  return (
    <ul className="ags">
      {rows.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            className={a.state === 'gone' ? 'ag gone' : 'ag'}
            aria-current={a.id === activeId}
            title={`${a.id} · ${AGENT_STATE[a.state]} · seen ${ago(a.last_seen, now)}`}
            onClick={() => onSelect(a.id)}
          >
            <Mark agent={a.id} size={18} mode={agentMode(a)} />
            <span className="ag-name">{shortName(a)}</span>
            <span className="ag-side">{a.side ?? ''}</span>
            <span className={`a-dot a-${a.state}`} role="img" aria-label={AGENT_STATE[a.state]} />
          </button>
        </li>
      ))}
      {folded > 0 && (
        <li>
          <button type="button" className="ag-more" onClick={() => setOpen(true)}>{folded} gone</button>
        </li>
      )}
      {open && agents.filter((a) => a.state === 'gone').length > 3 && (
        <li>
          <button type="button" className="ag-more" onClick={() => setOpen(false)}>hide gone</button>
        </li>
      )}
    </ul>
  )
}

/** The centre pane for a selected agent: who it is, what it last did, and what it is holding. */
function AgentCard({ agent, now, onSelect, onNewTerminal }: { agent: AgentDoc; now: number; onSelect: (id: string) => void; onNewTerminal?: () => void }) {
  return (
    <div className="transcript">
      <div className="col">
        <div className="agent-card">
          <div className="agent-head">
            <Mark agent={agent.id} size={40} mode={agentMode(agent)} />
            <div>
              <b>{shortName(agent)}</b>
              <span className="dim">{agent.human ? `works for ${agent.human}` : 'works for nobody on the roster'}</span>
            </div>
          </div>
          <dl>
            <dt>id</dt>
            <dd className="mono">{agent.id}</dd>
            <dt>side</dt>
            <dd>{agent.side ?? 'not set'}</dd>
            <dt>state</dt>
            <dd>
              <span className={`a-dot a-${agent.state}`} aria-hidden="true" /> {AGENT_STATE[agent.state]} · last seen {seen(agent.last_seen, now)} · {clock(agent.last_seen)}
            </dd>
            <dt>last tool</dt>
            <dd className="mono">{agent.last_tool ?? 'none yet'}</dd>
            <dt>calls</dt>
            <dd>{agent.calls}</dd>
          </dl>
        </div>
        <div className="sec">
          <span>HOLDING</span>
          <span>{agent.claims.length ? `${agent.claims.length} ${agent.claims.length === 1 ? 'claim' : 'claims'}` : ''}</span>
        </div>
        {agent.claims.map((t) => (
          <div key={t.id} className="ev call">
            <button type="button" className="row" onClick={() => onSelect(t.id)}>
              <span className="tool">task_claim</span>
              <span className="t target">{t.title}</span>
              <span className="ok">{t.paths.length} {t.paths.length === 1 ? 'path' : 'paths'}</span>
            </button>
            {t.paths.length > 0 && (
              <div className="body">
                <pre>{t.paths.join('\n')}</pre>
              </div>
            )}
          </div>
        ))}
        {!agent.claims.length && <p className="note">Holding no claims. It edits nothing until it calls task_claim.</p>}
        {onNewTerminal && (
          <button type="button" className="btn agent-term" onClick={onNewTerminal}>
            Open a terminal for a new agent
          </button>
        )}
      </div>
    </div>
  )
}

// ---------- chaos switch (a demo tool: quiet in the status bar, confirm before turning it on) ----------

/** What someone asked the switch to do. Kept as an intent, so chaos turned on elsewhere never trips an "off". */
type ChaosAsk = 'on' | 'off' | null
type ChaosProps = { id: Identity; on: boolean; ready: boolean; ask: ChaosAsk; setAsk: (v: ChaosAsk) => void; onState: (c: ChaosState) => void }

function ChaosSwitch({ id, on, ready, ask, setAsk, onState }: ChaosProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const flip = useCallback(
    async (enabled: boolean) => {
      setBusy(true)
      setError('')
      try {
        onState(await setChaos(id, enabled))
        setAsk(null)
      } catch (e) {
        console.error(`turning chaos ${enabled ? 'on' : 'off'} failed`, e)
        setError(e instanceof Error ? e.message : 'The API did not answer.')
      }
      setBusy(false)
    },
    [id, onState, setAsk],
  )
  // Turning it off needs no confirm. An ask that the world already answered (someone else
  // switched it while the confirm was open) just closes.
  useEffect(() => {
    if (busy || error) return
    if (ask === 'off' && on) void flip(false)
    else if ((ask === 'off' && !on) || (ask === 'on' && on)) setAsk(null)
  }, [ask, on, busy, error, flip, setAsk])
  const close = () => {
    setAsk(null)
    setError('')
  }
  if (!ready) return null
  return (
    <>
      <button
        type="button"
        className={on ? 'sb-btn bad' : 'sb-btn sb-quiet'}
        aria-haspopup="dialog"
        title={on ? 'Turn the chaos switch off' : 'Demo tool: make indexing slow and flaky'}
        disabled={busy}
        onClick={() => (on ? void flip(false) : setAsk(ask === 'on' ? null : 'on'))}
      >
        {busy ? 'chaos…' : on ? 'chaos on' : 'chaos off'}
      </button>
      {(ask === 'on' && !on) || error ? (
        <div className="chaos-pop" role="dialog" aria-label="Chaos switch" onKeyDown={(e) => e.key === 'Escape' && close()}>
          {!on && (
            <>
              <b>Turn chaos on?</b>
              <p>Indexing waits 3 s and fails 20% of the time, for everyone on this deployment, until someone turns it off.</p>
            </>
          )}
          {error && <p className="bad" role="alert">Not switched: {error}</p>}
          <div className="chaos-actions">
            <button type="button" className="btn" onClick={close}>Cancel</button>
            {!on && (
              // biome-ignore lint/a11y/noAutofocus: the confirm exists to be answered
              <button type="button" className="btn primary" autoFocus disabled={busy} onClick={() => void flip(true)}>
                {busy ? 'Turning on…' : 'Turn chaos on'}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

// ---------- centre: one person ----------

function Who({ who, size, busy }: { who: string; size: number; busy?: boolean }) {
  if (isAgent(who)) return <Mark agent={who} size={size} mode={busy ? 'working' : 'still'} />
  return (
    <span className={busy ? 'av busy' : 'av'} style={{ width: size, height: size }}>
      {agentName(who).slice(0, 1)}
    </span>
  )
}

function TaskRow({ t, now, meta, onSelect }: { t: TaskDoc; now: number; meta: string; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="session" onClick={() => onSelect(t.id)}>
        <Mark agent={t.owner} size={28} mode={TASK_MARK[t.status]} />
        <span className="s-title">{t.title}</span>
        <span className="s-time">{ago(t.updated_at, now)}</span>
        <span className="s-meta">{meta}</span>
      </button>
    </li>
  )
}

/** Their own recent entries from the API, merged with what the stream adds while the page is open. */
function useSaid(team: string, m: Member) {
  const [loaded, setLoaded] = useState<{ who: string; docs: RawDoc[]; error?: string }>({ who: '', docs: [] })
  useEffect(() => {
    let dead = false
    loadRecent(team, m.who)
      .then((r) => !dead && setLoaded({ who: m.who, docs: r.docs }))
      .catch((e: unknown) => {
        console.error(`loading recent entries for ${m.who} failed`, e)
        if (!dead) setLoaded({ who: m.who, docs: [], error: e instanceof Error ? e.message : 'The API did not answer.' })
      })
    return () => {
      dead = true
    }
  }, [team, m.who])
  const said = mergeSaid(m.said, loaded.who === m.who ? loaded.docs : [])
  return { said, loading: loaded.who !== m.who, error: loaded.who === m.who ? loaded.error : undefined }
}

const paths = (t: TaskDoc) => `${t.paths.length} ${t.paths.length === 1 ? 'path' : 'paths'}`

function PersonView({ m, own, id, now, onSelect, owner }: { m: Member; own: { map?: OwnershipMapResponse; error?: string }; id: Identity; now: number; onSelect: (id: string) => void; owner: (who: string) => string }) {
  const name = agentName(m.who)
  const me = sameWho(m.who, id.who)
  const { said, loading: saidLoading, error: saidError } = useSaid(id.team, m)
  const sideOwn = own.map?.sides.find((s) => s.side === m.side)
  return (
    <div className="transcript">
      <div className="col person">
        <header className="p-head">
          <Who who={m.who} size={40} busy={m.working.length > 0} />
          <div>
            <h2>{name}</h2>
            <p className="dim">
              {m.captain ? `${m.captain} captain` : m.side ? `${m.side} side` : 'no side yet'} · {m.agents.length} {m.agents.length === 1 ? 'agent' : 'agents'} · {m.inBrain} in brain
            </p>
          </div>
        </header>

        <section>
          <div className="sec">
            <span>IN CHARGE OF</span>
            <span>{m.captain ? `captain · ${m.captain}` : m.side ? `${m.side} side` : ''}</span>
          </div>
          {m.side ? (
            <div className="p-role">
              <p>
                {m.captain
                  ? `${name} captains the ${m.side} side, which owns these paths.`
                  : `${name} works on the ${m.side} side${sideOwn?.captain ? `, captained by ${agentName(sideOwn.captain)}` : ''}. It owns these paths.`}{' '}
                A claim from {name} outside them is refused.
              </p>
              {sideOwn && (
                <div className="p-paths">
                  {sideOwn.paths.map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </div>
              )}
              {!own.map && !own.error && <p role="status">Loading which paths that side owns…</p>}
              {m.holding.length > 0 && (
                <>
                  <p>Holding now, so nobody else can claim them:</p>
                  <div className="p-paths held">
                    {m.holding.map((p) => (
                      <code key={p}>{p}</code>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="pane-empty">No side yet. It shows once {name} claims a task or a capture names a side.</p>
          )}
          {own.error && <p className="pane-empty bad" role="alert">Side ownership did not load: {own.error}</p>}
        </section>

        {m.agents.length > 0 && (
          <section>
            <div className="sec">
              <span>AGENTS</span>
              <span>{m.agents.filter((a) => a.state === 'active').length} active</span>
            </div>
            <ul className="sessions">
              {m.agents.map((a) => (
                <li key={a.id}>
                  <button type="button" className="session" onClick={() => onSelect(a.id)}>
                    <Mark agent={a.id} size={28} mode={agentMode(a)} />
                    <span className="s-title">{shortName(a)}</span>
                    <span className="s-time">{ago(a.last_seen, now)}</span>
                    <span className="s-meta">
                      {a.state}
                      {a.last_tool ? ` · last ${a.last_tool}` : ''} · {a.claims.length ? `on ${a.claims[0]?.title}` : 'no claim'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="sec">
            <span>WORKING ON</span>
            <span>{m.working.length}</span>
          </div>
          {m.working.length ? (
            <ul className="sessions">
              {m.working.map((t) => (
                <TaskRow key={t.id} t={t} now={now} onSelect={onSelect} meta={`Working${t.owner === m.who ? '' : ` via ${owner(t.owner)}`} · ${t.side} · ${paths(t)}${t.pr ? ` · PR ${t.pr}` : ''}`} />
              ))}
            </ul>
          ) : (
            <p className="pane-empty">{name} holds no claim right now.</p>
          )}
        </section>

        <section>
          <div className="sec">
            <span>ASSIGNED</span>
            <span>{m.assigned.length}</span>
          </div>
          {me && m.assigned.length > 0 && <p className="p-hint">jam suggested these for you. Open one to accept it, dismiss it or copy its prompt.</p>}
          {m.assigned.length ? (
            <ul className="sessions">
              {m.assigned.map((t) => (
                <TaskRow key={t.id} t={t} now={now} onSelect={onSelect} meta={t.reason ?? `Proposed by ${t.proposed_by ?? 'jam'}`} />
              ))}
            </ul>
          ) : (
            <p className="pane-empty">No work orders are waiting for {name}. jam drafts them from todos the team says out loud.</p>
          )}
        </section>

        {m.finished.length > 0 && (
          <section>
            <div className="sec">
              <span>FINISHED</span>
              <span>{m.finished.length}</span>
            </div>
            <ul className="sessions">
              {m.finished.slice(0, 8).map((t) => (
                <TaskRow key={t.id} t={t} now={now} onSelect={onSelect} meta={`Done${t.owner === m.who ? '' : ` via ${owner(t.owner)}`} · ${t.side}${t.pr ? ` · PR ${t.pr}` : ''}${t.note ? ` · ${t.note}` : ''}`} />
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="sec">
            <span>LATEST FROM {name.toUpperCase()}</span>
            <span>{said.length}</span>
          </div>
          {said.slice(0, 6).map((d) => (
            <Entry key={d.id} doc={d} />
          ))}
          {saidError && <p className="pane-empty bad" role="alert">Their entries did not load: {saidError}</p>}
          {!said.length && saidLoading && <p className="pane-empty" role="status">Loading {name}'s entries…</p>}
          {!said.length && !saidLoading && !saidError && <p className="pane-empty">Nothing from {name} in the brain yet.</p>}
        </section>
      </div>
    </div>
  )
}

// ---------- centre: what the brain holds about the task, or the whole feed ----------

function Entry({ doc }: { doc: RawDoc }) {
  const name = useContext(NameCtx)
  const meta = `${name(doc.who)} · ${doc.type} · ${clock(doc.at)}`
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

type ThreadProps = { live: Live; task: TaskDoc | undefined; id: Identity; outgoing: Outgoing[]; now: number; onSignOut: () => void }

function Thread({ live, task, id, outgoing, now, onSignOut }: ThreadProps) {
  const name = useContext(NameCtx)
  const box = useRef<HTMLDivElement>(null)
  // Follow new entries only while the reader is at the bottom; never yank someone reading back.
  const atBottom = useRef(true)
  const shownTask = useRef<string | undefined>(undefined)
  const shownBox = useRef<HTMLDivElement | null>(null)
  const docs = useMemo(() => (task ? threadFor(task, live.docs) : [...live.docs].reverse()), [task, live.docs])
  const pending = pendingCaptures(live.captures, now)
  const sending = outgoing.filter((o) => !live.captures.some((c) => c.capture_id === o.capture_id))
  const [openPaths, setOpenPaths] = useState(true)
  const count = docs.length + pending.length + sending.length
  const lastId = docs.at(-1)?.id

  // Layout effect: scroll before paint, so a scroll event from the new height cannot mark the reader as away first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection, the entry count or the newest entry changes (the list is capped, so the count alone stops moving)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    // A new selection, or a fresh list after the loading or empty state, starts at the bottom.
    const switched = shownTask.current !== task?.id || shownBox.current !== el
    shownTask.current = task?.id
    shownBox.current = el
    if (switched || atBottom.current) el.scrollTop = el.scrollHeight
  }, [task?.id, count, lastId, live.status])

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
        <button type="button" className="btn" onClick={onSignOut}>Use a different team code</button>
      </div>
    )

  return (
    <div
      className="transcript"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      <div className="col">
        {task && (
          <div className="ev call">
            <button type="button" className="row" aria-expanded={openPaths} onClick={() => setOpenPaths(!openPaths)}>
              <span className="t">{openPaths ? '▾' : '▸'}</span>
              <span className="tool">task_claim</span>
              <span className="t target">{name(task.owner)} is editing</span>
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
              <kbd>⏎</kbd> save <kbd>⇧⏎</kbd> new line
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
  const [tab, setTab] = useState<'claims' | 'captures' | 'terminal'>('claims')
  const [shut, setShut] = useState(false)
  const [termOn, setTermOn] = useState(false)
  const [height, setHeight] = useState(loadPanelHeight)
  const claims = live.tasks.filter((t) => t.status === 'claimed')
  const name = useContext(NameCtx)
  const open = (t: typeof tab) => {
    setTab(t)
    setShut(false)
    if (t === 'terminal') setTermOn(true)
  }
  const grip = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    let h = height
    const move = (m: PointerEvent) => {
      h = clampPanel(height + startY - m.clientY, window.innerHeight)
      setHeight(h)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      savePanelHeight(h)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <section className={shut ? 'panel shut' : 'panel'} style={{ '--panel-h': `${height}px` } as CSSProperties}>
      {!shut && <div className="panel-grip" title="Drag to resize" onPointerDown={grip} />}
      <div className="ptabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'claims'} onClick={() => open('claims')}>Open claims</button>
        <button type="button" role="tab" aria-selected={tab === 'captures'} onClick={() => open('captures')}>Captures</button>
        <button type="button" role="tab" aria-selected={tab === 'terminal'} onClick={() => open('terminal')}>Terminal</button>
        <button type="button" className="collapse" aria-label={shut ? 'Open panel' : 'Close panel'} onClick={() => setShut(!shut)}>
          {shut ? '▴' : '▾'}
        </button>
      </div>
      {termOn && <Terminal visible={!shut && tab === 'terminal'} />}
      {!shut && tab !== 'terminal' && (
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
                      <td><span className="who"><Mark agent={t.owner} size={14} />{name(t.owner)}</span></td>
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

type ItemRowProps = { kind: string; who: string; source?: string; at: string; text: string; prov?: string; used?: boolean; rejected?: boolean; children?: ReactNode }

function ItemRow({ kind, who, source, at, text, prov, used, rejected, children }: ItemRowProps) {
  const name = useContext(NameCtx)
  return (
    <article className={['item', used && 'used', rejected && 'rejected'].filter(Boolean).join(' ')}>
      <div className="k">
        <span className={kind === 'blocker' ? 'kind blk' : 'kind'}>{kind}</span>· {name(who)}
        {source ? ` · ${source}` : ''} · {clock(at)}
      </div>
      <p>{text}</p>
      {prov && <span className="prov">{prov}</span>}
      {children}
    </article>
  )
}

/** A librarian item with its grade: confidence, the human verdict, or Confirm / Reject. */
function ItemCard({ item, id, used }: { item: ItemDoc; id: Identity; used?: boolean }) {
  const [mine, setMine] = useState<ItemDoc>()
  const [state, setState] = useState<{ busy?: ItemVerdict; error?: string }>({})
  // Search hits are a snapshot, so keep our own answer unless the prop has caught up or moved on.
  const cur = mine && itemNewer(mine, item) ? mine : item
  const judge = async (verdict: ItemVerdict) => {
    setState({ busy: verdict })
    try {
      setMine(await setVerdict(id, item.id, verdict))
      setState({})
    } catch (e) {
      console.error(`marking item ${item.id} ${verdict} failed`, e)
      setState({ error: e instanceof Error ? e.message : 'The verdict was not saved.' })
    }
  }
  const n = cur.raw_ids.length
  return (
    <ItemRow kind={cur.kind} who={cur.who} at={cur.at} text={cur.text} used={used} rejected={cur.verdict === 'rejected'} prov={n ? `from ${n} ${n === 1 ? 'quote' : 'quotes'}` : undefined}>
      <div className="grade">
        {cur.confidence !== undefined && <span title="How directly the quoted words support this, by jam's own score">jam {pct(cur.confidence)}</span>}
        {cur.verdict ? (
          <span className={cur.verdict === 'rejected' ? 'bad' : undefined}>
            {cur.verdict}
            {cur.verified_by ? ` by ${agentName(cur.verified_by)}` : ''}
          </span>
        ) : (
          <>
            <span className="grow" />
            <button type="button" className="text-btn" disabled={!!state.busy} onClick={() => void judge('confirmed')}>{state.busy === 'confirmed' ? 'Confirming…' : 'Confirm'}</button>
            <button type="button" className="text-btn" disabled={!!state.busy} onClick={() => void judge('rejected')}>{state.busy === 'rejected' ? 'Rejecting…' : 'Reject'}</button>
          </>
        )}
      </div>
      {state.error && <span className="prov bad" role="alert">Not saved: {state.error}</span>}
    </ItemRow>
  )
}

const rawRow = (d: RawDoc, used?: boolean) => (
  <ItemRow key={d.id} kind={d.type} who={d.who} at={d.at} text={d.text} used={used} prov={d.source_ref} />
)

function Brain({ live, id, task }: { live: Live; id: Identity; task: TaskDoc | undefined }) {
  const team = id.team
  const name = useContext(NameCtx)
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
          {found && 'hits' in found && found.hits.map((h) => (h.layer === 'item' ? <ItemCard key={h.doc.id} item={h.doc} id={id} /> : rawRow(h.doc)))}
        </>
      ) : (
        <>
          {task && (
            <>
              <div className="sec">
                <span>WRITTEN BY {name(task.owner).toUpperCase()}</span>
                <span>{written.length}</span>
              </div>
              {written.map((d) => rawRow(d, true))}
              {!written.length && <p className="pane-empty">{name(task.owner)} has not added anything to the brain.</p>}
            </>
          )}
          <div className="sec">
            <span>DECISIONS AND ITEMS</span>
            <span>
              {live.items.length} ·{' '}
              <a className="sec-link" href={decisionLogUrl(team)} target="_blank" rel="noopener">decision log</a>
            </span>
          </div>
          {live.items.map((i) => <ItemCard key={i.id} item={i} id={id} />)}
          {live.status === 'ready' && !live.items.length && <p className="pane-empty">No items yet. The librarian extracts decisions, todos and questions from captures.</p>}
          <div className="sec">
            <span>LATEST</span>
            <span>{live.docs.length > LATEST_MAX ? `${LATEST_MAX} of ${live.docs.length}` : live.docs.length}</span>
          </div>
          {live.docs.slice(0, LATEST_MAX).map((d) => rawRow(d))}
          {live.status === 'ready' && !live.docs.length && <p className="pane-empty">Nothing captured yet.</p>}
        </>
      )}
    </>
  )
}

function Files({ tasks }: { tasks: TaskDoc[] }) {
  const name = useContext(NameCtx)
  if (!tasks.length) return <p className="pane-empty">No files are claimed right now.</p>
  return (
    <>
      {tasks.map((t) => (
        <div key={t.id}>
          <div className="sec">
            <span>{name(t.owner).toUpperCase()}</span>
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
