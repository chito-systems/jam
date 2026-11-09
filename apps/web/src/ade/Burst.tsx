// The mic going live, printed: a ring of halftone dots blooms out from the talk button across the
// whole screen and leaves clean paper behind. Pink plate on the jam screen angle, a yellow plate a
// beat behind and off register, like the load-in. About 0.6s; nothing at all with reduced motion.
//
// Built for a phone: one canvas lives for the whole session (iOS is slow to free canvases, so a
// fresh one per tap stalls or stops drawing), the screen grid is computed once per size, and each
// frame only touches the dots inside the moving ring.
import { useCallback, useEffect, useRef } from 'react'

const INKS = {
  light: { pink: '#ff48b0', yellow: '#ffe800' },
  dark: { pink: '#ff62bd', yellow: '#ffe94a' },
}
const DURATION = 600
const PITCH = 14
/** How thick the travelling ring is, in px. */
const BAND = 140
const PLATES = [
  { ink: 'yellow', angle: 0, dx: -4, dy: 3, lag: 0.08 },
  { ink: 'pink', angle: 75, dx: 0, dy: 0, lag: 0 },
] as const

/** 0 → 1 → 0 as the ring passes a dot: quick to ink, slower to lift. */
export function bump(phase: number): number {
  if (phase <= 0 || phase >= 1) return 0
  return phase < 0.28 ? phase / 0.28 : (1 - phase) / 0.72
}

const easeOut = (t: number) => 1 - (1 - t) ** 3
const themeNow = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

/** Every dot of one rotated screen that lands on a w×h viewport (with a margin), as flat x,y pairs. */
export function screenDots(w: number, h: number, angle: number, pitch: number, margin = 0): Float32Array {
  const a = (angle * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const span = Math.ceil((Math.hypot(w, h) + 2 * margin) / pitch)
  const out: number[] = []
  for (let i = -span; i <= span; i++) {
    for (let j = -span; j <= span; j++) {
      const x = w / 2 + (i * cos - j * sin) * pitch
      const y = h / 2 + (i * sin + j * cos) * pitch
      if (x > -margin && y > -margin && x < w + margin && y < h + margin) out.push(x, y)
    }
  }
  return new Float32Array(out)
}

/** A canvas to mount once, and `fire(x, y)` to print a burst from that point. */
export function useBurst() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const grid = useRef<{ w: number; h: number; dots: Float32Array[] } | null>(null)
  const raf = useRef(0)

  // Size the canvas and lay the grids out once, again only if the viewport changes.
  const prepare = useCallback(() => {
    const el = canvas.current
    if (!el) return null
    const w = window.innerWidth
    const h = window.innerHeight
    if (grid.current?.w === w && grid.current.h === h) return grid.current
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    el.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    grid.current = { w, h, dots: PLATES.map((p) => screenDots(w, h, p.angle, PITCH, PITCH)) }
    return grid.current
  }, [])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const fire = useCallback(
    (x: number, y: number) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const el = canvas.current
      const g = prepare()
      const ctx = el?.getContext('2d')
      if (!el || !g || !ctx) return
      cancelAnimationFrame(raf.current)
      const theme = themeNow()
      const inks = INKS[theme]
      const reach = Math.max(Math.hypot(x, y), Math.hypot(g.w - x, y), Math.hypot(x, g.h - y), Math.hypot(g.w - x, g.h - y)) + BAND
      const max = PITCH * 0.56
      el.style.visibility = 'visible'
      const t0 = performance.now()

      const draw = (now: number) => {
        const t = (now - t0) / DURATION
        ctx.globalCompositeOperation = 'source-over'
        ctx.clearRect(0, 0, g.w, g.h)
        ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply'
        PLATES.forEach((p, k) => {
          const tp = Math.min(1, Math.max(0, (t - p.lag) / (1 - p.lag)))
          if (tp <= 0) return
          const r = easeOut(tp) * reach
          const fade = tp > 0.8 ? (1 - tp) / 0.2 : 1
          const lo = r - BAND
          const dots = g.dots[k] as Float32Array
          ctx.fillStyle = inks[p.ink]
          ctx.beginPath()
          for (let i = 0; i < dots.length; i += 2) {
            const gx = (dots[i] as number) + p.dx
            const gy = (dots[i + 1] as number) + p.dy
            const ddx = gx - x
            const ddy = gy - y
            const d2 = ddx * ddx + ddy * ddy
            // Only the ring: skip what it hasn't reached and what it has already passed.
            if (d2 > r * r || (lo > 0 && d2 < lo * lo)) continue
            const size = bump((r - Math.sqrt(d2)) / BAND) * fade * max
            if (size < 0.5) continue
            ctx.moveTo(gx + size, gy)
            ctx.arc(gx, gy, size, 0, Math.PI * 2)
          }
          ctx.fill()
        })
        if (t < 1) {
          raf.current = requestAnimationFrame(draw)
          return
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.clearRect(0, 0, g.w, g.h)
        el.style.visibility = 'hidden'
      }
      raf.current = requestAnimationFrame(draw)
    },
    [prepare],
  )

  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative canvas, never focusable; the talk button announces the recording
  const view = <canvas ref={canvas} className="c-burst" aria-hidden="true" style={{ visibility: 'hidden' }} />
  return { view, fire }
}
