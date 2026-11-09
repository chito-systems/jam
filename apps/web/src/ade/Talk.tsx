import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { audioContext, playChime } from './chime'
import { micProblem, pickMime, tooShort, uploadClip } from './clip'
import type { Identity } from './live'

/** A voice note on its way to the API, shown in the feed until its capture event arrives. */
export type Outgoing = { key: string; capture_id?: string; error?: string }

type Rec = { rec: MediaRecorder; stream: MediaStream; parts: Blob[]; at: string; t0: number; stopMeter: () => void }

const BANDS = [0, 1, 2, 3, 4]
/** Inside the JAM iPhone app, mic permission lives in iOS Settings, not the page. */
const IN_SHELL = () => Boolean((window as Window & { webkit?: { messageHandlers?: { jam?: unknown } } }).webkit?.messageHandlers?.jam)

/** Stopping every track is what turns the browser's mic indicator off. */
const release = (s: MediaStream) => {
  for (const t of s.getTracks()) t.stop()
}

/** Five frequency bands of the mic, written straight to the bars each frame (no re-render). */
function meter(stream: MediaStream, bars: (HTMLElement | null)[]): () => void {
  const c = audioContext()
  if (!c) return () => {}
  const src = c.createMediaStreamSource(stream)
  const an = c.createAnalyser()
  an.fftSize = 256
  src.connect(an)
  const buf = new Uint8Array(an.frequencyBinCount)
  let raf = 0
  const tick = () => {
    an.getByteFrequencyData(buf)
    for (const i of BANDS) {
      let sum = 0
      for (let k = 1 + i * 4; k < 5 + i * 4; k++) sum += buf[k] ?? 0
      const b = bars[i]
      if (b) b.style.transform = `scaleY(${Math.max(0.15, sum / 1020)})`
    }
    raf = requestAnimationFrame(tick)
  }
  tick()
  return () => {
    cancelAnimationFrame(raf)
    src.disconnect()
  }
}

/** Toggle mode (the phone) gives up after this long and sends what it has. */
export const TOGGLE_MAX_MS = 120_000

type TalkProps = {
  id: Identity
  onOutgoing: (o: Outgoing) => void
  /** Tap to start, tap again to send (the phone), instead of hold and release. */
  toggle?: boolean
  /** Called with the button the moment a toggle recording is asked for. */
  onPress?: (button: HTMLElement) => void
}

/** Hold the button, or Alt+Space anywhere, to record; release to send; Esc cancels.
 *  With `toggle`, a tap starts and the next tap sends. */
export function Talk({ id, onOutgoing, toggle = false, onPress }: TalkProps) {
  const [t0, setT0] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [msg, setMsg] = useState('')
  const [say, setSay] = useState('')
  const pressing = useRef<'pointer' | 'key' | 'toggle' | null>(null)
  const cur = useRef<Rec | null>(null)
  const bars = useRef<(HTMLElement | null)[]>([])
  const hintTimer = useRef(0)
  // Each mic request gets a number, so a stale one (a tap, then a hold, during the permission prompt) is dropped.
  const req = useRef(0)

  const hint = (text: string) => {
    setMsg(text)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setMsg((m) => (m === text ? '' : m)), 2500)
  }
  const fail = (text: string) => {
    console.debug('talk: failed:', text)
    setMsg(text)
    playChime('error')
  }

  const start = (via: 'pointer' | 'key' | 'toggle') => {
    console.debug('talk: start', via)
    if (pressing.current || cur.current) return
    const problem = micProblem({ secure: window.isSecureContext, media: Boolean(navigator.mediaDevices?.getUserMedia), recorder: typeof MediaRecorder !== 'undefined' })
    if (problem) return fail(problem)
    pressing.current = via
    setMsg('')
    const mine = ++req.current
    const opened = (stream: MediaStream) => {
      if (mine !== req.current || cur.current) return release(stream)
      if (!pressing.current) {
        release(stream)
        return hint('The mic is ready. Hold to talk.')
      }
      try {
        const mime = pickMime((m) => MediaRecorder.isTypeSupported?.(m) ?? false)
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
        const r: Rec = { rec, stream, parts: [], at: new Date().toISOString(), t0: Date.now(), stopMeter: meter(stream, bars.current) }
        rec.ondataavailable = (e) => {
          if (e.data.size) r.parts.push(e.data)
        }
        rec.start()
        console.debug('talk: recording', rec.mimeType || '(browser default)')
        cur.current = r
        setT0(r.t0)
        setNow(r.t0)
        setSay('Recording. Release to send, Esc to cancel.')
        playChime('start')
      } catch (e) {
        release(stream)
        refused(e)
      }
    }
    const refused = (e: unknown) => {
      if (mine !== req.current) return
      pressing.current = null
      console.error('opening the microphone failed', e)
      if (e instanceof DOMException && e.name === 'NotAllowedError') return fail(`Microphone access is blocked. Allow it ${IN_SHELL() ? 'in Settings → JAM → Microphone' : 'for this site in the browser'}, then ${toggle ? 'tap' : 'hold'} again.`)
      fail(`The microphone did not open: ${e instanceof Error ? e.message : String(e)}`)
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(opened, refused)
  }

  const stop = (send: boolean) => {
    pressing.current = null
    const r = cur.current
    if (!r) return
    cur.current = null
    setT0(null)
    const ms = Date.now() - r.t0
    const keep = send && !tooShort(ms)
    console.debug('talk: stop', { send, ms, keep, state: r.rec.state })
    if (!send) setSay('Cancelled. Nothing was sent.')
    if (send && !keep) hint(toggle ? 'Too short. Tap, talk, then tap again.' : 'Hold to talk')
    if (!keep) playChime('cancel')
    const finish = () => {
      r.stopMeter()
      release(r.stream)
      if (!keep) return
      const blob = new Blob(r.parts, { type: r.rec.mimeType || 'audio/webm' })
      console.debug('talk: clip', { bytes: blob.size, parts: r.parts.length, type: blob.type })
      if (!blob.size) return fail('The mic gave no audio, so nothing was sent.')
      const key = r.at
      onOutgoing({ key })
      setSay('Sending the voice note.')
      uploadClip(id, blob, r.at).then(
        (res) => {
          console.debug('talk: sent', res.capture_id)
          onOutgoing({ key, capture_id: res.capture_id })
          setSay('Voice note sent.')
          playChime('sent')
        },
        (e: unknown) => {
          console.error('uploading a voice note failed', e)
          const why = e instanceof Error ? e.message : 'the upload failed'
          onOutgoing({ key, error: why })
          fail(`Voice note not sent: ${why}`)
        },
      )
    }
    if (r.rec.state === 'inactive') return finish()
    r.rec.onstop = finish
    r.rec.stop()
  }

  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const api = useRef({ start, stop })
  api.current = { start, stop }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) api.current.start('key')
      } else if (e.key === 'Escape' && pressing.current) {
        e.preventDefault()
        api.current.stop(false)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || pressing.current !== 'key') return
      e.preventDefault()
      api.current.stop(true)
    }
    // Hold mode: letting go of the window is letting go of the button. Toggle mode (the phone)
    // ignores blur, which iOS fires when the mic switches on; it sends when the app is put away.
    const blur = () => !toggleRef.current && pressing.current && api.current.stop(true)
    const hidden = () => document.visibilityState === 'hidden' && pressing.current && api.current.stop(true)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      api.current.stop(false)
    }
  }, [])

  useEffect(() => {
    if (t0 === null) return
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [t0])
  // A forgotten toggle recording sends itself rather than recording all afternoon.
  useEffect(() => {
    if (t0 === null || !toggle) return
    const t = window.setTimeout(() => api.current.stop(true), TOGGLE_MAX_MS)
    return () => window.clearTimeout(t)
  }, [t0, toggle])

  const tap = (button: HTMLElement) => {
    if (cur.current) return stop(true)
    if (pressing.current) {
      // Tapped again while the mic was still opening: call it off.
      pressing.current = null
      req.current++
      return
    }
    onPress?.(button)
    start('toggle')
  }

  const end = () => pressing.current === 'pointer' && stop(true)
  return (
    <>
      <button
        type="button"
        className="talk"
        aria-label={toggle ? (t0 === null ? 'Talk: tap to record' : 'Tap to send') : 'Talk: hold to record'}
        aria-keyshortcuts="Alt+Space"
        aria-pressed={t0 !== null}
        title="Hold to talk (⌥Space)"
        {...(toggle
          ? { onClick: (e: MouseEvent<HTMLButtonElement>) => tap(e.currentTarget) }
          : {
              onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
                if (e.button !== 0) return
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                start('pointer')
              },
              onPointerUp: end,
              onPointerCancel: end,
              onLostPointerCapture: end,
            })}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="talk-idle">
          <i />
          Talk <kbd>⌥Space</kbd>
        </span>
        <span className="talk-live">
          <i />
          <span className="lvl">
            {BANDS.map((n) => (
              <b key={n} ref={(el) => { bars.current[n] = el }} />
            ))}
          </span>
          <span className="secs">{t0 === null ? '0.0' : ((now - t0) / 1000).toFixed(1)}s</span>
        </span>
      </button>
      <span className="talk-msg" role="status">{msg}</span>
      <span className="sr" aria-live="polite">{say}</span>
    </>
  )
}
