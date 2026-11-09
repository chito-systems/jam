import type { Side } from '@hh/shared'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import './guide.css'
import { agentCount, BRIDGE_COMMAND, BRIDGE_HEALTH, type Bridge, GUIDE_KEY, type Mic, mcpCommand, setupLine, stepStatus } from './steps'
import type { Identity, Live } from './live'

// The setup checklist. Every tick comes from a live signal; nothing is ticked by reading it.

type InstallPrompt = Event & { prompt: () => Promise<unknown> }
let installPrompt: InstallPrompt | null = null
const installWatchers = new Set<() => void>()
// Chrome fires this once, early, whether or not the guide is open: keep it for the Install button.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e as InstallPrompt
    for (const f of installWatchers) f()
  })
}

export function guideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === 'seen'
  } catch {
    return false // Storage blocked: the guide opens on each visit, which is the safe side.
  }
}

function markSeen() {
  try {
    localStorage.setItem(GUIDE_KEY, 'seen')
  } catch {
    // Storage blocked: nothing to remember it in; it opens again next visit.
  }
}

const standaloneNow = () => window.matchMedia('(display-mode: standalone)').matches

async function micPermission(): Promise<Mic> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return p.state
  } catch {
    return 'unknown' // Safari and Firefox may not know the "microphone" permission name.
  }
}

async function bridgeUp(): Promise<Bridge> {
  const ctl = new AbortController()
  const t = window.setTimeout(() => ctl.abort(), 1500)
  try {
    // The bridge answers with CORS only to origins it accepts, so ok means this page can use it.
    const res = await fetch(BRIDGE_HEALTH, { cache: 'no-store', signal: ctl.signal })
    return res.ok ? 'running' : 'not running'
  } catch {
    return 'not running' // The expected state on most laptops, not an error.
  } finally {
    window.clearTimeout(t)
  }
}

function Tick({ done }: { done: boolean }) {
  return (
    <span className={done ? 'glyph glyph-done' : 'glyph glyph-queued'} role="img" aria-label={done ? 'Done' : 'Not yet'}>
      {done && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.4l2.3 2.3 4.7-5.2" />
        </svg>
      )}
    </span>
  )
}

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  return (
    <li className={done ? 'g-step done' : 'g-step'}>
      <Tick done={done} />
      <div>
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  )
}

export function HelpIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6v.1" />
    </svg>
  )
}

export function Guide({ id, live, onSignOut, onClose }: { id: Identity; live: Live; onSignOut: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [standalone, setStandalone] = useState(standaloneNow)
  const [canInstall, setCanInstall] = useState(Boolean(installPrompt))
  const [mic, setMic] = useState<Mic>('unknown')
  const [micMsg, setMicMsg] = useState('')
  const [bridge, setBridge] = useState<Bridge>('checking')
  const [side, setSide] = useState<Side>('frontend')
  const [said, setSaid] = useState('')

  const close = useCallback(() => {
    markSeen()
    onClose()
  }, [onClose])

  // Focus moves in on open and back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    box.current?.focus({ preventScroll: true })
    return () => opener?.focus()
  }, [])

  const checkBridge = useCallback(() => {
    setBridge('checking')
    void bridgeUp().then(setBridge)
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    const onMode = () => setStandalone(mq.matches)
    const onPrompt = () => setCanInstall(Boolean(installPrompt))
    mq.addEventListener('change', onMode)
    installWatchers.add(onPrompt)
    void micPermission().then(setMic)
    checkBridge()
    return () => {
      mq.removeEventListener('change', onMode)
      installWatchers.delete(onPrompt)
    }
  }, [checkBridge])

  const install = async () => {
    const p = installPrompt
    if (!p) return
    installPrompt = null
    setCanInstall(false)
    await p.prompt()
    setStandalone(standaloneNow())
  }

  const allowMic = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setMicMsg('The microphone only works on https or localhost. Open JAM from its https address.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const t of stream.getTracks()) t.stop()
      setMic('granted')
      setMicMsg('')
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMic('denied')
        setMicMsg('The browser refused. Allow the microphone in this site’s settings (the icon at the left of the address bar), then try again.')
      } else if (name === 'NotFoundError') {
        setMicMsg('No microphone was found on this computer.')
      } else {
        console.error('asking for the microphone failed', e)
        setMicMsg('The microphone could not be opened.')
      }
    }
  }

  const copy = (text: string, what: string) =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setSaid(`Copied the ${what}.`),
        (e: unknown) => {
          console.warn('copying to the clipboard was blocked', e)
          setSaid('The browser blocked copying. Select the command and copy it by hand.')
        },
      )

  const trap = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'Tab' || !box.current) return
    const els = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')]
    const first = els[0]
    const last = els[els.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault()
      last?.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first?.focus()
    }
  }

  const done = stepStatus({ identity: id, standalone, mic, docs: live.docs, stats: live.stats, bridge })
  const agents = agentCount(live.stats)
  const cmd = mcpCommand(window.location.origin, id, side)

  return (
    <div className="guide-wrap" onPointerDown={close}>
      <div
        ref={box}
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={trap}
      >
        <header className="g-head">
          <div>
            <h2 id="guide-title">Set up JAM</h2>
            <p className="g-count">{setupLine(done)}</p>
          </div>
          <button type="button" className="btn" onClick={close}>Close</button>
        </header>
        <ol className="g-steps">
          <Step done={done.in} title="You are in">
            <p>
              Team <b>{id.team}</b> as <b>{id.who}</b>. The team code must match on every laptop.
              {!id.persisted && ' This browser is not saving it, so you will be asked again next visit.'}
            </p>
            <div className="g-act"><button type="button" className="text-btn" onClick={onSignOut}>Change</button></div>
          </Step>
          <Step done={done.install} title="Install JAM as an app">
            {done.install ? (
              <p>JAM is running as an installed app.</p>
            ) : canInstall ? (
              <p>Gives JAM its own window and Dock icon.</p>
            ) : (
              <p>
                Chrome or Edge: the install icon at the right of the address bar.
                <br />
                Safari: File → Add to Dock.
              </p>
            )}
            <p className="dim">An installed copy picks up each merge the next time it loads.</p>
            {canInstall && !done.install && (
              <div className="g-act"><button type="button" className="btn primary" onClick={() => void install()}>Install</button></div>
            )}
          </Step>
          <Step done={done.mic} title="Turn on the microphone">
            <p>{mic === 'granted' ? 'Allowed for this site.' : mic === 'denied' ? 'Blocked for this site.' : 'Not allowed yet.'} Hold Talk or <kbd>⌥Space</kbd>, let go to send; <kbd>Esc</kbd> cancels.</p>
            {micMsg && <p className="bad" role="alert">{micMsg}</p>}
            {!done.mic && (
              <div className="g-act"><button type="button" className="btn primary" onClick={() => void allowMic()}>Allow microphone</button></div>
            )}
          </Step>
          <Step done={done.say} title="Say or write one thing">
            <p>{done.say ? 'The brain has something from you.' : 'Hold Talk and say what you are working on, or type it in the note box under the feed.'}</p>
          </Step>
          <Step done={done.agent} title="Connect your coding agent">
            <p>Run this once in a terminal. Your agent can then search the brain, read recent context and decisions, add notes, and claim tasks.</p>
            <fieldset className="g-side">
              <legend>Your side</legend>
              {(['frontend', 'backend'] as const).map((s) => (
                <button key={s} type="button" className={side === s ? 'btn chosen' : 'btn'} aria-pressed={side === s} onClick={() => {
                  setSide(s)
                  setSaid('')
                }}>{s}</button>
              ))}
            </fieldset>
            <div className="g-cmd">
              <code>{cmd}</code>
              <button type="button" className="btn" onClick={() => void copy(cmd, 'agent command')}>{said === 'Copied the agent command.' ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="dim">{agents ? `The brain has heard from ${agents} ${agents === 1 ? 'agent' : 'agents'}.` : 'No agent has written to the brain yet. It counts after its first note or task claim.'}</p>
          </Step>
          <Step done={done.terminal} title="Open a terminal here">
            <p>The Terminal tab talks to a small bridge that opens a shell on this computer only. Start it from the repo:</p>
            <div className="g-cmd">
              <code>{BRIDGE_COMMAND}</code>
              <button type="button" className="btn" onClick={() => void copy(BRIDGE_COMMAND, 'bridge command')}>{said === 'Copied the bridge command.' ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="g-act">
              <span className="dim" role="status">Bridge {bridge === 'checking' ? 'checking…' : bridge}</span>
              <button type="button" className="text-btn" disabled={bridge === 'checking'} onClick={checkBridge}>Check again</button>
            </div>
          </Step>
        </ol>
        <p className="g-keys">
          <span><kbd>⌘K</kbd> commands</span>
          <span><kbd>⌥Space</kbd> talk</span>
          <span><kbd>/</kbd> search the brain</span>
          <span><kbd>j</kbd> <kbd>k</kbd> move between tasks</span>
          <span><kbd>Esc</kbd> cancel</span>
        </p>
        <p className="g-said" role="status" aria-live="polite">{said}</p>
      </div>
    </div>
  )
}
