import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { bridgeUp } from './Guide'
import { type Identity, saveIdentity } from './live'
import type { ThemeMode } from './parts'
import { loadSide, saveSide, type Side } from './sessions'
import { GROUPS, SHORTCUTS, TALK_KEYS } from './shortcuts'
import { BRIDGE_COMMAND, type Bridge } from './steps'
import './settings.css'

const REPO = 'https://github.com/chito-systems/jam'

/** The overlay both panels share: the palette's backdrop and card, focus in on open and back on close. */
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    box.current?.focus({ preventScroll: true })
    return () => opener?.focus()
  }, [])
  return (
    <div className="palette-wrap" onPointerDown={onClose}>
      <div
        ref={box}
        tabIndex={-1}
        className="palette sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onClose()
        }}
      >
        <div className="sheet-head">
          <b>{label}</b>
          <button type="button" className="icon" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose}>×</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: T[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="fun-seg" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </fieldset>
  )
}

type SettingsProps = {
  id: Identity
  onIdentity: (id: Identity) => void
  mode: ThemeMode
  onMode: (m: ThemeMode) => void
  sound: boolean
  onSound: () => void
  onClose: () => void
}

export function Settings({ id, onIdentity, mode, onMode, sound, onSound, onClose }: SettingsProps) {
  const [team, setTeam] = useState(id.team)
  const [who, setWho] = useState(id.who)
  const [side, setSide] = useState<Side>(loadSide)
  const [bridge, setBridge] = useState<Bridge>('checking')
  const [version, setVersion] = useState('…')
  const changed = team.trim().toLowerCase() !== id.team || who.trim().toLowerCase() !== id.who

  useEffect(() => {
    let dead = false
    void bridgeUp().then((b) => !dead && setBridge(b))
    fetch('/healthz', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ version?: string }>)
      .then((h) => !dead && setVersion(h.version ?? 'unknown'))
      .catch((e: unknown) => {
        console.error('reading the server version from /healthz failed', e)
        if (!dead) setVersion('did not answer')
      })
    return () => {
      dead = true
    }
  }, [])

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (team.trim() && who.trim() && changed) onIdentity(saveIdentity(team, who))
  }

  return (
    <Sheet label="Settings" onClose={onClose}>
      <form className="set-row set-id" onSubmit={save}>
        <span className="set-k">Identity</span>
        <label>
          <span className="dim">Team code</span>
          <input value={team} maxLength={64} onChange={(e) => setTeam(e.target.value)} autoComplete="off" autoCapitalize="none" />
        </label>
        <label>
          <span className="dim">Your name</span>
          <input value={who} maxLength={64} onChange={(e) => setWho(e.target.value)} autoComplete="off" autoCapitalize="none" />
        </label>
        <button type="submit" className="btn primary" disabled={!changed || !team.trim() || !who.trim()}>Save</button>
      </form>
      <div className="set-row">
        <span className="set-k">Side</span>
        <Seg label="Side" value={side} options={['backend', 'frontend']} onChange={(s) => { setSide(s); saveSide(s) }} />
        <span className="dim">default for + New agent</span>
      </div>
      <div className="set-row">
        <span className="set-k">Appearance</span>
        <Seg label="Appearance" value={mode} options={['light', 'dark', 'system']} onChange={onMode} />
      </div>
      <div className="set-row">
        <span className="set-k">Sound</span>
        <Seg label="Sound" value={sound ? 'on' : 'off'} options={['on', 'off']} onChange={(v) => (v === 'on') !== sound && onSound()} />
      </div>
      <div className="set-row">
        <span className="set-k">Capture</span>
        <span>hold {TALK_KEYS.map((k) => <kbd key={k}>{k}</kbd>)} to talk</span>
      </div>
      <div className="set-row">
        <span className="set-k">Terminal bridge</span>
        <span role="status">{bridge === 'checking' ? 'checking…' : bridge}</span>
        {bridge === 'not running' && <code>{BRIDGE_COMMAND}</code>}
      </div>
      <div className="set-row">
        <span className="set-k">About</span>
        <span>server build <b className="mono">{version}</b></span>
        <a href={REPO} target="_blank" rel="noopener">chito-systems/jam ↗</a>
      </div>
    </Sheet>
  )
}

export function CheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="Keyboard shortcuts" onClose={onClose}>
      <div className="cheat">
        {GROUPS.map((g) => (
          <section key={g}>
            <div className="sec"><span>{g.toUpperCase()}</span><span /></div>
            <dl>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.label} className="cheat-row">
                  <dt>{s.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                  <dd>{s.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  )
}
