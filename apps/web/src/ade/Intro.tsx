import { useEffect, useRef, useState } from 'react'
import './intro.css'

// The load-in: the jam mark is printed onto the sheet (a yellow plate lands off register,
// the pink plate presses in and snaps into register), the wordmark sets beside it, and the
// sheet peels up to show the workspace. It plays on every launch. If the brain is slow,
// the mark turns the way an agent's mark turns while it works, until the data arrives.

/** The print always gets this long, so the moment reads even on a warm cache. */
export const MIN_MS = 900
/** Never hold the workspace back longer than this, ready or not. */
export const MAX_MS = 4000
export const EXIT_MS = 350
export const FADE_MS = 150

/** When the sheet comes off: tapped, out of time, or the data is in and the print has landed. */
export function shouldExit(s: { elapsed: number; ready: boolean; skipped: boolean }): boolean {
  return s.skipped || s.elapsed >= MAX_MS || (s.ready && s.elapsed >= MIN_MS)
}

// Same inks and screen angles as Mark.tsx, so the intro's mark is the header's mark, larger.
const INKS = {
  light: { pink: '#ff48b0', yellow: '#ffe800' },
  dark: { pink: '#ff62bd', yellow: '#ffe94a' },
}
const ANGLE = { pink: 75, yellow: 0 }

type Circle = { x: number; y: number; r: number }

/** The jam shape (tri2): three pairs of circles around the centre. */
function jamCircles(rot: number): Circle[] {
  const out: Circle[] = []
  for (let k = 0; k < 3; k++) {
    const a = rot - Math.PI / 2 + (k * 2 * Math.PI) / 3
    const cx = Math.cos(a) * 0.52
    const cy = Math.sin(a) * 0.52
    const tx = -Math.sin(a)
    const ty = Math.cos(a)
    out.push({ x: cx + tx * 0.19, y: cy + ty * 0.19, r: 0.27 }, { x: cx - tx * 0.19, y: cy - ty * 0.19, r: 0.27 })
  }
  return out
}

const hash = (i: number, j: number, s: number) => {
  const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453
  return v - Math.floor(v)
}
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3
/** Lands a little past and settles: the plate snapping into register. */
const easeBack = (t: number) => {
  const x = clamp01(t)
  const c = 1.9
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2
}

type Plate = { cx: number; cy: number; scale: number; color: string; angle: number; pitch: number; seed: number; gain: number; t: number; spread: number }

/** One halftone plate. Each dot arrives at its own moment (ink catching paper unevenly) and swells as it lands. */
function plate(ctx: CanvasRenderingContext2D, circles: Circle[], o: Plate) {
  const a = (o.angle * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const p = o.pitch
  const n = Math.ceil((o.scale * 1.6 + p) / p) + 1
  const ui = Math.round((o.cx * cos + o.cy * sin) / p)
  const vi = Math.round((-o.cx * sin + o.cy * cos) / p)
  ctx.fillStyle = o.color
  ctx.beginPath()
  for (let i = ui - n; i <= ui + n; i++)
    for (let j = vi - n; j <= vi + n; j++) {
      const x = i * p * cos - j * p * sin
      const y = i * p * sin + j * p * cos
      const dx = (x - o.cx) / o.scale
      const dy = (y - o.cy) / o.scale
      if (dx < -1.15 || dx > 1.15 || dy < -1.15 || dy > 1.15) continue
      let tone = 0
      for (const c of circles) {
        const d = Math.hypot(dx - c.x, dy - c.y) / c.r
        tone = Math.max(tone, 1 - smooth((d - 1 + 0.16) / 0.32))
      }
      if (tone < 0.03) continue
      // Arrival: centre first, then outward, with a little grain.
      const at = Math.hypot(dx, dy) * 0.32 + hash(i, j, o.seed) * o.spread
      const land = clamp01((o.t - at) / 0.16)
      if (land <= 0) continue
      const swell = land < 1 ? easeOut(land) * (1 + 0.18 * Math.sin(Math.PI * land)) : 1
      tone *= (0.78 + 0.44 * hash(i, j, o.seed)) * o.gain
      const r = p * 0.5 * Math.sqrt(Math.min(1, tone)) * 1.12 * swell
      if (r < 0.22) continue
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
  ctx.fill()
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

const SIZE = 72

export function Intro({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [reduce] = useState(reducedMotion)
  const [minDone, setMinDone] = useState(false)
  const [holding, setHolding] = useState(false)
  const [exiting, setExiting] = useState(false)
  const done = useRef(onDone)
  done.current = onDone

  // The clock: the print's minimum, a note if the brain is slow, and the hard cap.
  useEffect(() => {
    const timers = [
      window.setTimeout(() => setMinDone(true), reduce ? 400 : MIN_MS),
      window.setTimeout(() => setHolding(true), 1400),
      window.setTimeout(() => setExiting(true), MAX_MS),
    ]
    return () => {
      for (const t of timers) window.clearTimeout(t)
    }
  }, [reduce])

  useEffect(() => {
    if (ready && minDone) setExiting(true)
  }, [ready, minDone])

  useEffect(() => {
    if (!exiting) return
    const t = window.setTimeout(() => done.current(), reduce ? FADE_MS : EXIT_MS)
    return () => window.clearTimeout(t)
  }, [exiting, reduce])

  useEffect(() => {
    const skip = (e: KeyboardEvent) => e.key === 'Escape' && setExiting(true)
    window.addEventListener('keydown', skip)
    return () => window.removeEventListener('keydown', skip)
  }, [])

  // The press. One canvas, redrawn each frame until the intro unmounts.
  useEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const theme = themeNow()
    const inks = INKS[theme]
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pad = 10 // room for the plates to land off register
    const box = SIZE + pad * 2
    c.width = c.height = Math.round(box * dpr)
    const pitch = SIZE / 12
    const mid = box / 2

    const draw = (t: number) => {
      // Turn only while holding for data, easing up to an agent's working speed.
      const s = t - 0.9
      const rot = s <= 0 ? 0 : s < 0.5 ? 0.45 * s * s : 0.45 * (0.25 + (s - 0.5))
      const circles = jamCircles(rot)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, box, box)
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply'
      const base = { scale: SIZE / 2 - 1, pitch }
      // Yellow first, off register, then it settles under the pink and lifts away.
      const yIn = easeOut(t / 0.5)
      const yGain = 0.5 * (1 - smooth((t - 0.55) / 0.35))
      if (yGain > 0.01)
        plate(ctx, circles, { ...base, cx: mid - 7 * (1 - yIn) - 1.2, cy: mid + 5 * (1 - yIn) + 0.8, color: inks.yellow, angle: ANGLE.yellow, seed: 3, gain: yGain, t: t + 0.05, spread: 0.12 })
      // Pink presses in a beat later, lands a few points out and snaps into register.
      const pk = easeBack((t - 0.12) / 0.5)
      plate(ctx, circles, { ...base, cx: mid + 6 * (1 - pk), cy: mid - 4 * (1 - pk), color: inks.pink, angle: ANGLE.pink, seed: 11, gain: 1, t: t - 0.1, spread: 0.16 })
    }

    if (reduce) {
      draw(0.9) // the finished print: plates in register, not yet turning
      return
    }
    let raf = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      draw((now - t0) / 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [reduce])

  return (
    <div
      className="jam-intro"
      data-state={exiting ? 'out' : 'in'}
      data-motion={reduce ? 'reduce' : 'full'}
      onPointerDown={() => setExiting(true)}
      role="status"
      aria-label="Opening JAM"
    >
      <div className="jam-intro-lockup" aria-hidden="true">
        <canvas ref={canvas} className="jam-intro-mark" />
        <span className="jam-intro-wm">
          <span>J</span>
          <span>A</span>
          <span>M</span>
        </span>
      </div>
      <p className="jam-intro-note" data-on={holding && !exiting} aria-hidden="true">
        Reading the team brain
      </p>
    </div>
  )
}
