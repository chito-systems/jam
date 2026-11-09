// The mic going live, printed: a ring of halftone dots blooms out from the talk button across the
// whole screen and leaves clean paper behind. Pink plate on the jam screen angle, a yellow plate a
// beat behind and off register, like the load-in. About 0.7s; nothing at all with reduced motion.
import { useEffect, useRef } from 'react'

const INKS = {
  light: { pink: '#ff48b0', yellow: '#ffe800' },
  dark: { pink: '#ff62bd', yellow: '#ffe94a' },
}
const DURATION = 700
const PITCH = 13
/** How thick the travelling ring is, in px. */
const BAND = 150

/** 0 → 1 → 0 as the ring passes a dot: quick to ink, slower to lift. */
export function bump(phase: number): number {
  if (phase <= 0 || phase >= 1) return 0
  return phase < 0.28 ? phase / 0.28 : (1 - phase) / 0.72
}

const easeOut = (t: number) => 1 - (1 - t) ** 3
const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

type Plate = { color: string; angle: number; dx: number; dy: number; lag: number }

export function Burst({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone()
      return
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = window.innerWidth
    const h = window.innerHeight
    el.width = w * dpr
    el.height = h * dpr
    ctx.scale(dpr, dpr)
    const theme = themeNow()
    ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply'
    const inks = INKS[theme]
    const plates: Plate[] = [
      { color: inks.yellow, angle: 0, dx: -4, dy: 3, lag: 0.07 },
      { color: inks.pink, angle: 75, dx: 0, dy: 0, lag: 0 },
    ]
    // Far enough that the ring clears the farthest corner before it fades.
    const reach = Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y)) + BAND
    const t0 = performance.now()
    let raf = 0

    const draw = (now: number) => {
      const t = (now - t0) / DURATION
      ctx.clearRect(0, 0, w, h)
      for (const p of plates) {
        const tp = Math.min(1, Math.max(0, (t - p.lag) / (1 - p.lag)))
        if (tp <= 0) continue
        const r = easeOut(tp) * reach
        const fade = tp > 0.8 ? (1 - tp) / 0.2 : 1
        const a = (p.angle * Math.PI) / 180
        const cos = Math.cos(a)
        const sin = Math.sin(a)
        ctx.fillStyle = p.color
        ctx.beginPath()
        // Walk the rotated screen grid over the whole viewport.
        const span = Math.ceil(Math.hypot(w, h) / PITCH)
        for (let i = -span; i <= span; i++) {
          for (let j = -span; j <= span; j++) {
            const gx = x + p.dx + (i * cos - j * sin) * PITCH
            const gy = y + p.dy + (i * sin + j * cos) * PITCH
            if (gx < -PITCH || gy < -PITCH || gx > w + PITCH || gy > h + PITCH) continue
            const d = Math.hypot(gx - x, gy - y)
            const size = bump((r - d) / BAND) * fade * PITCH * 0.56
            if (size < 0.4) continue
            ctx.moveTo(gx + size, gy)
            ctx.arc(gx, gy, size, 0, Math.PI * 2)
          }
        }
        ctx.fill()
      }
      if (t < 1) raf = requestAnimationFrame(draw)
      else onDone()
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [x, y, onDone])

  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative canvas, never focusable; the talk button announces the recording
  return <canvas ref={canvas} className="c-burst" aria-hidden="true" />
}
