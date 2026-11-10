import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunState } from './data'
import { Mark } from './Mark'

// Pieces shared by the live page and the sample page.

export const STATE_LABEL: Record<RunState, string> = {
  needs_input: 'Needs you',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  done: 'Done',
  cancelled: 'Stopped',
}

/** The one status glyph. Used in the session header and anywhere a state needs a mark. */
export function StatusGlyph({ state }: { state: RunState }) {
  return (
    <span className={`glyph glyph-${state}`} role="img" aria-label={STATE_LABEL[state]}>
      {state === 'done' && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.4l2.3 2.3 4.7-5.2" />
        </svg>
      )}
      {(state === 'failed' || state === 'cancelled') && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {state === 'failed' ? <path d="M3 3l6 6M9 3l-6 6" /> : <path d="M3 6h6" />}
        </svg>
      )}
    </span>
  )
}

/** Backticks become code. Enough markdown for transcripts and notes. */
export function Prose({ text }: { text: string }) {
  return (
    <p>
      {text.split('`').map((p, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: a static split, never reordered
        i % 2 ? <code key={i}>{p}</code> : <span key={i}>{p}</span>,
      )}
    </p>
  )
}

/** Code freeze for the Cloud Native Hackathon, Salt Lake City. */
export const FREEZE_AT = '2026-11-09T16:30:00-07:00'

export function FreezeClock() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const s = Math.floor((new Date(FREEZE_AT).getTime() - now) / 1000)
  // Past the freeze the countdown has nothing to say.
  if (s <= 0) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <span className="crumb mono">
      {Math.floor(s / 3600)}:{pad(Math.floor(s / 60) % 60)}:{pad(s % 60)} to freeze
    </span>
  )
}

// ---------- theme ----------

type Theme = 'light' | 'dark'
/** What the person picked: a theme, or follow the system. */
export type ThemeMode = Theme | 'system'

const DARK = '(prefers-color-scheme: dark)'
const systemTheme = (): Theme => (window.matchMedia(DARK).matches ? 'dark' : 'light')

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem('jam-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch (e) {
    console.warn('reading jam-theme from localStorage failed; using the system setting', e)
  }
  return 'system'
}

export function useTheme(): { theme: Theme; mode: ThemeMode; flip: () => void; setMode: (m: ThemeMode) => void } {
  const [mode, setMode] = useState<ThemeMode>(initialMode)
  const [sys, setSys] = useState<Theme>(systemTheme)
  useEffect(() => {
    const mq = window.matchMedia(DARK)
    const on = () => setSys(systemTheme())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const theme = mode === 'system' ? sys : mode
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      // "system" is the absence of a saved theme, which other pages already read that way.
      if (mode === 'system') localStorage.removeItem('jam-theme')
      else localStorage.setItem('jam-theme', mode)
    } catch (e) {
      console.warn('saving jam-theme to localStorage failed; the theme applies for this visit only', e)
    }
  }, [theme, mode])
  const flip = useCallback(() => setMode(theme === 'dark' ? 'light' : 'dark'), [theme])
  return { theme, mode, flip, setMode }
}

/** Shows the mode a click switches to: a sun in dark mode, a moon in light. */
export function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === 'dark' ? (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
    </svg>
  )
}

export function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 6h2.5l3.5-3v10l-3.5-3h-2.5z" />
      {on ? <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" /> : <path d="M11 6l3.5 4M14.5 6l-3.5 4" />}
    </svg>
  )
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
      <circle cx="8" cy="8" r="4.6" />
    </svg>
  )
}

export function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  )
}

export function PaneIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </svg>
  )
}

// ---------- palette ----------

export type Command = { id?: string; label: string; hint?: string; keys?: string; agent?: string; run: () => void }

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const byKey = useRef(false)
  const list = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()))
  // Arrow keys can move past the visible rows; keep the active one in view (hover never scrolls).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active row changes
  useEffect(() => {
    if (!byKey.current) return
    byKey.current = false
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [i])
  const go = (c?: Command) => {
    if (!c) return
    onClose()
    c.run()
  }
  return (
    <div className="palette-wrap" onPointerDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
          autoFocus
          value={q}
          placeholder="Type a command or a name"
          aria-label="Command"
          onChange={(e) => {
            setQ(e.target.value)
            setI(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              byKey.current = true
              setI(Math.min(list.length - 1, i + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              byKey.current = true
              setI(Math.max(0, i - 1))
            }
            if (e.key === 'Enter') go(list[i])
          }}
        />
        <ul ref={listRef}>
          {list.map((c, n) => (
            <li key={c.id ?? c.label}>
              <button type="button" data-active={n === i} onPointerEnter={() => setI(n)} onClick={() => go(c)}>
                {c.agent ? <Mark agent={c.agent} size={14} /> : <span className="glyph-space" />}
                <span>{c.label}</span>
                {c.hint && <span className="hint">{c.hint}</span>}
                {c.keys && <kbd className={c.hint ? undefined : 'hint-kbd'}>{c.keys}</kbd>}
              </button>
            </li>
          ))}
          {!list.length && <li className="pane-empty">No match.</li>}
        </ul>
      </div>
    </div>
  )
}

/** True at phone width. One Talk renders at a time, so its ⌥Space listener is never doubled. */
const PHONE = '(max-width: 640px)'
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE)
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return phone
}
