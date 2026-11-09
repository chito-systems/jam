import type { AgentDoc } from '@hh/shared'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { agentName } from './live'
import { agentCommand, agentTitle, MAX_SESSIONS, NO_TABS, nextAgentName, nextShellTitle, type Side, tabsReducer } from './sessions'
import { Terminal } from './Terminal'
import './tabs.css'

// Centre-pane tabs: the team feed, then one live terminal per tab. Every terminal stays mounted
// (own WebSocket, own shell) until its tab closes; inactive ones are hidden with CSS.

let seq = 0
/** ?dryagent in the URL makes "New agent" echo its name instead of starting a paid Claude session. */
const DRY = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('dryagent')

export type TermTabsApi = ReturnType<typeof useTermTabs>

export function useTermTabs(me: string, team: string, agents: AgentDoc[]) {
  const [tabs, dispatch] = useReducer(tabsReducer, NO_TABS)
  const newAgent = useCallback(
    (side: Side = 'backend') => {
      const name = nextAgentName(me, [...tabs.list.flatMap((s) => (s.agentName ? [s.agentName] : [])), ...agents.map((a) => agentName(a.id))])
      const run = agentCommand(window.location.origin, team, name, side, DRY)
      dispatch({ t: 'add', s: { id: `t${++seq}`, title: agentTitle(name, me), kind: 'agent', agentName: name, side, run } })
    },
    [me, team, agents, tabs.list],
  )
  const newShell = useCallback(() => dispatch({ t: 'add', s: { id: `t${++seq}`, title: nextShellTitle(tabs.list), kind: 'shell' } }), [tabs.list])
  const show = useCallback((id: string | null) => dispatch({ t: 'show', id }), [])
  const close = useCallback((id: string) => dispatch({ t: 'close', id }), [])
  /** Switches to the open terminal for this agent id ("agent:cam-opus-1"); false when there is none. */
  const focusAgent = useCallback(
    (id: string) => {
      const s = tabs.list.find((x) => x.agentName && x.agentName === agentName(id))
      if (s) dispatch({ t: 'show', id: s.id })
      return !!s
    },
    [tabs.list],
  )
  return { ...tabs, full: tabs.list.length >= MAX_SESSIONS, newAgent, newShell, show, close, focusAgent }
}

export function TabStrip({ t, first = 'Team feed' }: { t: TermTabsApi; first?: string }) {
  const [menu, setMenu] = useState(false)
  const [side, setSide] = useState<Side>('backend')
  const box = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the active tab changes.
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [t.active, t.list.length])
  useEffect(() => {
    if (!menu) return
    const off = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setMenu(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    window.addEventListener('pointerdown', off)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])
  const shut = (id: string, kind: string, title: string) => {
    if (kind === 'agent' && !window.confirm(`Close ${title}? Its shell and the agent running in it stop.`)) return
    t.close(id)
  }
  return (
    <div className="ctabs">
      <div className="ctabs-scroll" ref={strip} role="tablist" aria-label="Centre pane">
        <button type="button" role="tab" className="ctab" aria-selected={t.active === null} onClick={() => t.show(null)}>
          {first}
        </button>
        {t.list.map((s) => (
          <span key={s.id} className="ctab-wrap" data-kind={s.kind}>
            <button type="button" role="tab" className="ctab" aria-selected={t.active === s.id} title={s.agentName ?? s.title} onClick={() => t.show(s.id)}>
              {s.kind === 'agent' ? <span className="ctab-dot" aria-hidden="true" /> : <span className="ctab-sh" aria-hidden="true">$</span>}
              {s.title}
            </button>
            <button type="button" className="ctab-x" aria-label={`Close ${s.title}`} onClick={() => shut(s.id, s.kind, s.title)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="ctabs-add" ref={box}>
        <button type="button" className="ctab ctab-plus" aria-label="New terminal" aria-haspopup="menu" aria-expanded={menu} disabled={t.full} title={t.full ? `${MAX_SESSIONS} terminals open` : 'New terminal'} onClick={() => setMenu(!menu)}>
          +
        </button>
        {menu && (
          <div className="ctabs-menu" role="menu">
            <fieldset className="ctabs-side" aria-label="Side">
              {(['backend', 'frontend'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={side === v} onClick={() => setSide(v)}>
                  {v}
                </button>
              ))}
            </fieldset>
            <button type="button" role="menuitem" onClick={() => {
                setMenu(false)
                t.newAgent(side)
              }}>
              New agent <span className="dim">claude, {side}</span>
            </button>
            <button type="button" role="menuitem" onClick={() => {
                setMenu(false)
                t.newShell()
              }}>
              New shell
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function TermStack({ t }: { t: TermTabsApi }) {
  if (!t.list.length) return null
  return (
    <div className="tstack" hidden={t.active === null}>
      {t.list.map((s) => (
        <Terminal key={s.id} visible={t.active === s.id} run={s.run} />
      ))}
    </div>
  )
}
