import { createContext, useContext, useEffect, useRef } from 'react'

// The agent mark: a halftone print of a few circles, one ink and shape per agent.
// It only moves while that agent works (turns) or waits on a human (drifts out of focus).

export type MarkMode = 'working' | 'waiting' | 'idle' | 'still'
export const ThemeCtx = createContext<'light' | 'dark'>('light')

type Ink = 'pink' | 'yellow' | 'blue' | 'indigo' | 'red' | 'green' | 'ghost'
type Shape = 'tri2' | 'tri' | 'ring5' | 'pair'
type Identity = { ink: Ink; mis?: Ink; shape: Shape }

const INKS: Record<'light' | 'dark', Record<Ink, string>> = {
  light: { pink: '#ff48b0', yellow: '#ffe800', blue: '#0078bf', indigo: '#3d2fa3', red: '#f2462e', green: '#00a95c', ghost: '#bdb8ae' },
  // The same print at night: inks lifted so they read on dark paper.
  dark: { pink: '#ff62bd', yellow: '#ffe94a', blue: '#3aa5ee', indigo: '#8a7bff', red: '#ff6a52', green: '#2fd487', ghost: '#4d4942' },
}
const SCREEN: Record<Ink, number> = { pink: 75, yellow: 0, blue: 15, indigo: 30, red: 60, green: 105, ghost: 45 }

/** Marks the team has already met. Any other name gets a stable one from its hash. */
const marks: Record<string, Identity> = {
  jam: { ink: 'pink', shape: 'tri2' },
  'opus-1': { ink: 'indigo', mis: 'blue', shape: 'tri2' },
  fable: { ink: 'blue', shape: 'ring5' },
  'opus-2': { ink: 'green', shape: 'pair' },
  'sonnet-1': { ink: 'pink', shape: 'tri' },
  'sonnet-2': { ink: 'red', mis: 'yellow', shape: 'pair' },
}
const HASH_INKS = ['pink', 'blue', 'indigo', 'green', 'red'] as const
const HASH_SHAPES = ['tri2', 'tri', 'ring5', 'pair'] as const

const nameHash = (name: string) => {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  return h >>> 0
}

/** One identity per agent name: a known mark, or a deterministic ink and shape. "agent:" is ignored. */
export function markFor(name: string): Identity {
  const key = name.replace(/^agent:/, '')
  const known = marks[key]
  if (known) return known
  const h = nameHash(key)
  return { ink: HASH_INKS[h % HASH_INKS.length] ?? 'pink', shape: HASH_SHAPES[(h >>> 8) % HASH_SHAPES.length] ?? 'tri' }
}

type Circle = { x: number; y: number; r: number }

function shapeCircles(shape: Shape, rot: number): Circle[] {
  const around = (n: number, rad: number, r: number) =>
    Array.from({ length: n }, (_, k) => {
      const a = rot - Math.PI / 2 + (k * 2 * Math.PI) / n
      return { x: Math.cos(a) * rad, y: Math.sin(a) * rad, r }
    })
  if (shape === 'pair') {
    const s = 0.8 * 0.46
    return [
      { x: -Math.cos(rot) * s, y: -Math.sin(rot) * s, r: 0.48 },
      { x: Math.cos(rot) * s, y: Math.sin(rot) * s, r: 0.48 },
    ]
  }
  if (shape === 'tri') return around(3, 0.48, 0.44)
  if (shape === 'ring5') return around(5, 0.6, 0.33)
  const out: Circle[] = [] // tri2: three pairs
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

type Pass = { circles: Circle[]; cx: number; cy: number; scale: number; color: string; angle: number; pitch: number; soft: number; seed: number; gain: number }

function print(ctx: CanvasRenderingContext2D, o: Pass) {
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
      for (const c of o.circles) {
        const d = Math.hypot(dx - c.x, dy - c.y) / c.r
        tone = Math.max(tone, 1 - smooth((d - 1 + o.soft) / (2 * o.soft)))
      }
      if (tone < 0.03) continue
      tone *= (1 - 0.22 + 0.44 * hash(i, j, o.seed)) * o.gain
      const r = p * 0.5 * Math.sqrt(Math.min(1, tone)) * 1.12
      if (r < 0.22) continue
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
  ctx.fill()
}

export function Mark({ agent, size, mode = 'still' }: { agent: string; size: number; mode?: MarkMode }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const theme = useContext(ThemeCtx)

  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const id = markFor(agent)
    const inks = INKS[theme]
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = c.height = Math.round(size * dpr)
    const seed = (nameHash(agent) % 97) + 1

    const draw = (t: number) => {
      const idle = mode === 'idle'
      const rot = mode === 'working' ? t * 0.45 + seed : 0
      const soft = idle ? 0.3 : mode === 'waiting' ? 0.16 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.2)) : 0.16
      const pitch = Math.max(1.6, size / 12)
      const circles = shapeCircles(id.shape, rot)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, size, size)
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply'
      const base = { circles, scale: size / 2 - 1, pitch }
      if (id.mis && !idle)
        print(ctx, { ...base, cx: size / 2 + Math.max(0.6, size / 30), cy: size / 2 + Math.max(0.4, size / 45), color: inks[id.mis], angle: SCREEN[id.mis], soft: soft + 0.05, seed: 3, gain: 0.55 })
      const ink: Ink = idle ? 'ghost' : id.ink
      print(ctx, { ...base, cx: size / 2, cy: size / 2, color: inks[ink], angle: SCREEN[ink], soft, seed, gain: 1 })
    }

    draw(0)
    const moving = (mode === 'working' || mode === 'waiting') && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!moving) return
    let raf = 0
    let last = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      if (now - last > 40) {
        last = now
        draw((now - t0) / 1000)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [agent, size, mode, theme])

  return <canvas ref={ref} className="agent-mark" style={{ width: size, height: size }} />
}
