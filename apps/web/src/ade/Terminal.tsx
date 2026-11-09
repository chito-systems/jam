import type { FitAddon } from '@xterm/addon-fit'
import type { ITheme, Terminal as XTerm } from '@xterm/xterm'
import { useContext, useEffect, useRef, useState } from 'react'
import { BRIDGE_PORT, encodeInput, encodeResize } from '../../bridge/protocol'
import { ThemeCtx } from './Mark'
import './terminal.css'

// A real shell on the user's own computer, through the local bridge (apps/web/bridge).
// xterm loads on first open so it stays out of the main bundle.

type State = 'connecting' | 'open' | 'missing' | 'closed' | 'broken'
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`
const COMMAND = 'pnpm --filter @hh/web bridge'

function palette(el: Element, dark: boolean): ITheme {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--paper'),
    foreground: v('--ink'),
    cursor: v('--ink'),
    cursorAccent: v('--paper'),
    selectionBackground: v('--line'),
    black: dark ? v('--line') : v('--ink'),
    brightBlack: v('--mute'),
    red: v('--red'),
    white: dark ? v('--ink') : v('--mute'),
    brightWhite: v('--ink'),
  }
}

/** `run` is typed into the shell once, ~600 ms after the first connect, so the prompt is ready. */
export function Terminal({ visible, run }: { visible: boolean; run?: string }) {
  const theme = useContext(ThemeCtx)
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ x: XTerm; fit: FitAddon } | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const [ready, setReady] = useState(false)
  const [state, setState] = useState<State>('connecting')
  const [attempt, setAttempt] = useState(0)
  const ran = useRef(false)
  const runRef = useRef(run)

  useEffect(() => {
    let gone = false
    let ro: ResizeObserver | undefined
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css'), document.fonts.load("12.5px 'Geist Mono Variable'")]).then(
      ([{ Terminal: X }, { FitAddon: Fit }]) => {
        const el = host.current
        if (gone || !el) return
        const x = new X({ fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, monospace", fontSize: 12.5, cursorBlink: true, scrollback: 5000, theme: palette(el, document.documentElement.dataset.theme === 'dark') })
        const fit = new Fit()
        x.loadAddon(fit)
        x.open(el)
        x.onData((d) => {
          if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(encodeInput(d))
        })
        term.current = { x, fit }
        ro = new ResizeObserver(() => {
          if (!el.offsetWidth) return
          fit.fit()
          if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(encodeResize(x.cols, x.rows))
        })
        ro.observe(el)
        setReady(true)
      },
      (e: unknown) => {
        console.error('loading the terminal failed', e)
        if (!gone) setState('broken')
      },
    )
    return () => {
      gone = true
      ro?.disconnect()
      ws.current?.close()
      term.current?.x.dispose()
      term.current = null
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the Retry button's trigger.
  useEffect(() => {
    const t = term.current
    if (!ready || !t) return
    setState('connecting')
    const s = new WebSocket(BRIDGE_URL)
    s.binaryType = 'arraybuffer'
    ws.current = s
    let opened = false
    s.onopen = () => {
      opened = true
      setState('open')
      t.x.write('\x1b[2mConnected. This shell runs on your computer, not on the JAM server.\x1b[0m\r\n')
      t.fit.fit()
      s.send(encodeResize(t.x.cols, t.x.rows))
      t.x.focus()
      const cmd = runRef.current
      if (cmd && !ran.current) {
        ran.current = true
        window.setTimeout(() => {
          if (s.readyState === WebSocket.OPEN) s.send(encodeInput(`${cmd}\r`))
        }, 600)
      }
    }
    s.onmessage = (m) => t.x.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data as ArrayBuffer))
    s.onclose = (e) => {
      if (ws.current !== s) return
      if (!opened) console.error(`the terminal bridge at ${BRIDGE_URL} did not answer (code ${e.code})`)
      setState(opened ? 'closed' : 'missing')
    }
    return () => {
      ws.current = null
      s.close()
    }
  }, [ready, attempt])

  useEffect(() => {
    const t = term.current
    const el = host.current
    if (!ready || !t || !el) return
    // The theme attribute lands in the parent's effect, after this one: read on the next frame.
    const id = requestAnimationFrame(() => {
      t.x.options.theme = palette(el, theme === 'dark')
    })
    return () => cancelAnimationFrame(id)
  }, [ready, theme])

  useEffect(() => {
    if (visible && state === 'open') term.current?.x.focus()
  }, [visible, state])

  const retry = () => setAttempt((a) => a + 1)
  return (
    <div className="term" hidden={!visible}>
      <div className="term-screen" ref={host} />
      {state === 'connecting' && <p className="term-line">Connecting to the bridge on this computer…</p>}
      {state === 'missing' && (
        <div className="term-note">
          <p>The terminal bridge is not running. Start it in a terminal on this computer:</p>
          <code>{COMMAND}</code>
          <p>It opens a shell on this computer only; nothing is sent to the JAM server.</p>
          <button type="button" className="btn" onClick={retry}>Retry</button>
        </div>
      )}
      {state === 'broken' && (
        <div className="term-note" role="alert">
          <p>The terminal could not load. Reload the page to try again.</p>
        </div>
      )}
      {state === 'closed' && (
        <div className="term-note">
          <p>The shell exited or the bridge stopped.</p>
          <button type="button" className="btn" onClick={retry}>Reconnect</button>
        </div>
      )}
    </div>
  )
}
