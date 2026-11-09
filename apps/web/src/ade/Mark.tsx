import { createContext, useContext, useEffect, useRef } from 'react'

// The agent mark: a halftone print of a few circles, one ink and shape per agent.
// Agents running on a known model family wear that family's silhouette (a Claude spark,
// an OpenAI knot, a Gemini star…), still pressed in riso ink and varied per agent.
// It only moves while that agent works (turns) or waits on a human (drifts out of focus).

export type MarkMode = 'working' | 'waiting' | 'idle' | 'still'
export const ThemeCtx = createContext<'light' | 'dark'>('light')

export type Ink = 'pink' | 'yellow' | 'blue' | 'indigo' | 'red' | 'green' | 'orange' | 'teal' | 'ghost'
type Shape = 'tri2' | 'tri' | 'ring5' | 'pair' | 'dot' | 'quad' | 'flower' | 'row' | 'orbit' | 'ring7' | 'gitar' | Vendor
type Vendor = 'claude' | 'openai' | 'gemini' | 'meta' | 'grok'
/** v: this agent's own variation of its family silhouette, 0 to 1. */
type Identity = { ink: Ink; mis?: Ink; shape: Shape; v?: number }

const INKS: Record<'light' | 'dark', Record<Ink, string>> = {
  light: { pink: '#ff48b0', yellow: '#ffe800', blue: '#0078bf', indigo: '#3d2fa3', red: '#f2462e', green: '#00a95c', orange: '#ff6c2f', teal: '#00838a', ghost: '#bdb8ae' },
  // The same print at night: inks lifted so they read on dark paper.
  dark: { pink: '#ff62bd', yellow: '#ffe94a', blue: '#3aa5ee', indigo: '#8a7bff', red: '#ff6a52', green: '#2fd487', orange: '#ff8a55', teal: '#2fc0c8', ghost: '#4d4942' },
}
const SCREEN: Record<Ink, number> = { pink: 75, yellow: 0, blue: 15, indigo: 30, red: 60, green: 105, orange: 90, teal: 120, ghost: 45 }

/** Marks the team has already met. Any other name gets a stable one from its hash. */
const marks: Record<string, Identity> = {
  jam: { ink: 'pink', shape: 'tri2' },
  gitar: { ink: 'indigo', mis: 'pink', shape: 'gitar' },
  librarian: { ink: 'indigo', shape: 'flower' },
}
const HASH_INKS = ['pink', 'blue', 'indigo', 'green', 'red', 'orange', 'teal'] as const
const HASH_SHAPES = ['tri2', 'tri', 'ring5', 'pair', 'dot', 'quad', 'flower', 'row', 'orbit', 'ring7'] as const
// A second, offset ink for about one agent in three, as if the plates slipped.
const MIS_INKS = ['yellow', 'blue', 'pink', 'teal'] as const

/** Model families, matched on the agent's name, with the inks each family prints in. */
const VENDORS: { vendor: Vendor; test: RegExp; inks: readonly Ink[]; mis: readonly Ink[] }[] = [
  { vendor: 'claude', test: /claude|anthropic|opus|sonnet|haiku|fable/, inks: ['orange', 'red', 'orange', 'pink'], mis: ['yellow', 'pink', 'red'] },
  { vendor: 'openai', test: /gpt|openai|codex|(^|[^a-z])o[1-9]/, inks: ['teal', 'green', 'teal', 'indigo'], mis: ['yellow', 'blue', 'green'] },
  { vendor: 'gemini', test: /gemini|bard|google/, inks: ['blue', 'indigo', 'blue', 'pink'], mis: ['pink', 'yellow', 'teal'] },
  { vendor: 'meta', test: /llama|meta/, inks: ['blue', 'indigo', 'teal'], mis: ['pink', 'yellow'] },
  { vendor: 'grok', test: /grok|xai/, inks: ['indigo', 'red', 'teal'], mis: ['yellow', 'pink'] },
]

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
  const family = VENDORS.find((f) => f.test.test(key.toLowerCase()))
  if (family) {
    const ink = family.inks[h % family.inks.length] ?? 'orange'
    const mis = family.mis.filter((m) => m !== ink)[(h >>> 12) % 2] ?? 'yellow'
    return { ink, mis, shape: family.vendor, v: ((h >>> 4) % 1000) / 1000 }
  }
  const ink: Ink = HASH_INKS[h % HASH_INKS.length] ?? 'pink'
  const shape: Shape = HASH_SHAPES[(h >>> 8) % HASH_SHAPES.length] ?? 'tri'
  const mis = (h >>> 16) % 3 === 0 ? MIS_INKS.find((_, k) => k >= (h >>> 20) % MIS_INKS.length && MIS_INKS[k] !== ink) : undefined
  return mis ? { ink, mis, shape } : { ink, shape }
}

/** Every shape the marks can take, for galleries and tests. */
export const MARK_SHAPES: readonly Shape[] = HASH_SHAPES
export const MARK_VENDORS: readonly Vendor[] = VENDORS.map((f) => f.vendor)

// What the press can print: discs, rounded strokes, a pinched four-point star and
// rounded triangles. A prim marked cut knocks its shape out of everything else.
// tone (0 to 1, default 1) prints a prim lighter, or makes a cut only part-way pale.
// A blob is two discs melted together (a smooth union, k wide), the way a dividing cell pinches.
type Circle = { x: number; y: number; r: number }
type Stroke = { x1: number; y1: number; x2: number; y2: number; r: number }
type Star = { star: true; x: number; y: number; r: number; a: number; sy: number }
/** A triangle grown outwards by round, so its corners come out soft. */
type Tri = { tri: readonly [number, number, number, number, number, number]; round: number }
type Blob = { blob: true; ax: number; ay: number; bx: number; by: number; r: number; k: number }
export type Prim = (Circle | Stroke | Star | Tri | Blob) & { cut?: true; tone?: number }

/** Signed distance to a triangle: negative inside. */
function sdTri(px: number, py: number, [ax, ay, bx, by, cx, cy]: Tri['tri']) {
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const ex = x1 - x0
    const ey = y1 - y0
    const vx = px - x0
    const vy = py - y0
    const t = Math.max(0, Math.min(1, (vx * ex + vy * ey) / (ex * ex + ey * ey)))
    return { d: (vx - ex * t) ** 2 + (vy - ey * t) ** 2, side: vx * ey - vy * ex }
  }
  const es = [edge(ax, ay, bx, by), edge(bx, by, cx, cy), edge(cx, cy, ax, ay)]
  const turn = Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
  const inside = es.every((e) => e.side * turn <= 0)
  const d = Math.sqrt(Math.min(...es.map((e) => e.d)))
  return inside ? -d : d
}

/** How far a point sits from a shape, in multiples of its radius: 1 is the edge. */
function reach(p: Prim, dx: number, dy: number) {
  if ('tri' in p) return sdTri(dx, dy, p.tri) / p.round
  if ('blob' in p) {
    const da = Math.hypot(dx - p.ax, dy - p.ay) - p.r
    const db = Math.hypot(dx - p.bx, dy - p.by) - p.r
    const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (db - da)) / (p.k || 1e-6)))
    return 1 + (db + (da - db) * h - p.k * h * (1 - h)) / p.r
  }
  if ('star' in p) {
    const c = Math.cos(p.a)
    const s = Math.sin(p.a)
    const u = Math.abs((dx - p.x) * c + (dy - p.y) * s)
    const w = Math.abs((-(dx - p.x) * s + (dy - p.y) * c) / p.sy)
    return (u ** 0.62 + w ** 0.62) ** (1 / 0.62) / p.r
  }
  if ('x1' in p) {
    const vx = p.x2 - p.x1
    const vy = p.y2 - p.y1
    const t = Math.max(0, Math.min(1, ((dx - p.x1) * vx + (dy - p.y1) * vy) / (vx * vx + vy * vy || 1)))
    return Math.hypot(dx - p.x1 - vx * t, dy - p.y1 - vy * t) / p.r
  }
  return Math.hypot(dx - p.x, dy - p.y) / p.r
}

const jitter = (v: number, k: number) => {
  const x = Math.sin(v * 9301 + k * 49297) * 233280
  return x - Math.floor(x)
}
export const polar = (a: number, d: number) => ({ x: Math.cos(a) * d, y: Math.sin(a) * d })
export const stroke = (a: { x: number; y: number }, b: { x: number; y: number }, r: number): Stroke => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, r })

/** A family silhouette, bent a little by this agent's own v so no two print alike. */
function vendorPrims(vendor: Vendor, v: number, rot: number): Prim[] {
  const turn = rot + v * Math.PI * 2
  if (vendor === 'claude') {
    // The spark: uneven rounded rays from one point.
    const n = 8 + Math.floor(v * 4)
    return Array.from({ length: n }, (_, k) => {
      const a = turn + ((k + (jitter(v, k) - 0.5) * 0.3) * 2 * Math.PI) / n
      return stroke(polar(a, 0.16), polar(a, 0.68 + 0.26 * jitter(v, k + 20)), 0.1 + 0.03 * jitter(v, k + 40))
    })
  }
  if (vendor === 'openai') {
    // The knot: six rounded links swirling round an open centre.
    const twist = 0.75 + 0.35 * v
    return Array.from({ length: 6 }, (_, k) => {
      const a = turn + (k * Math.PI) / 3
      return stroke(polar(a, 0.74), polar(a + twist, 0.3), 0.15)
    })
  }
  if (vendor === 'gemini') {
    // The sparkle: a four-point star that twinkles rather than turns, sometimes with a small one beside it.
    const glint = 0.93 + 0.07 * Math.sin(rot * 2.4)
    const big: Star = { star: true, x: 0, y: 0, r: 1.02 * glint, a: 0.12 * Math.sin(rot * 1.3), sy: 0.9 + 0.25 * v }
    if (v < 0.5) return [big]
    const at = polar(-Math.PI / 4 + 0.25 * Math.sin(rot), 0.66)
    return [{ ...big, r: 0.9 * glint, x: -0.12, y: 0.12 }, { star: true, ...at, r: 0.36 * (2 - glint), a: 0, sy: 1 }]
  }
  if (vendor === 'meta') {
    // The loop: a lemniscate, drawn as short strokes.
    const r = 0.11 + 0.05 * v
    const tilt = turn * 0.25 - 0.2
    const pt = (t: number) => {
      const d = 1 + Math.sin(t) ** 2
      const x = (0.82 * Math.cos(t)) / d
      const y = (0.82 * Math.sin(t) * Math.cos(t)) / d + 0.06 * Math.sin(2 * t)
      return { x: x * Math.cos(tilt) - y * Math.sin(tilt), y: x * Math.sin(tilt) + y * Math.cos(tilt) }
    }
    return Array.from({ length: 28 }, (_, k) => stroke(pt((k * 2 * Math.PI) / 28), pt(((k + 1) * 2 * Math.PI) / 28), r))
  }
  // grok: a slash crossed by a shorter one.
  const a = Math.PI / 4 + (v - 0.5) * 0.3 + rot * 0.2
  return [
    stroke(polar(a, -0.82), polar(a, 0.82), 0.13),
    stroke(polar(a + Math.PI / 2, -0.55 - 0.2 * v), polar(a + Math.PI / 2, 0.42), 0.12),
  ]
}

/** Gitar: a guitar pick pointing right with an italic g cut through it. It strums while it works. */
function gitarPrims(rot: number): Prim[] {
  const a = 0.18 * Math.sin(rot * 3)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const at = (x: number, y: number) => ({ x: x * c - y * s, y: x * s + y * c })
  const pick = [at(-0.44, -0.5), at(-0.38, 0.5), at(0.56, -0.04)]
  const g = (pts: [number, number][]): Prim[] =>
    pts.slice(1).map(([x, y], k) => {
      const [x0, y0] = pts[k] ?? [x, y]
      return { ...stroke(at(x0, y0), at(x, y), 0.085), cut: true }
    })
  return [
    { tri: [pick[0]?.x ?? 0, pick[0]?.y ?? 0, pick[1]?.x ?? 0, pick[1]?.y ?? 0, pick[2]?.x ?? 0, pick[2]?.y ?? 0], round: 0.28 },
    { ...at(-0.1, -0.1), r: 0.2, cut: true },
    ...g([[0.13, -0.24], [0.04, 0.3], [-0.26, 0.3]]),
  ]
}

function shapePrims(id: Identity, rot: number): Prim[] {
  const { shape } = id
  if (shape === 'gitar') return gitarPrims(rot)
  if (VENDORS.some((f) => f.vendor === shape)) return vendorPrims(shape as Vendor, id.v ?? 0, rot)
  return shapeCircles(shape, rot)
}

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
  if (shape === 'ring7') return around(7, 0.66, 0.25)
  if (shape === 'quad') return around(4, 0.5, 0.4)
  // A single seed. It has no turn to show, so it breathes instead.
  if (shape === 'dot') return [{ x: 0, y: 0, r: 0.78 + 0.07 * Math.sin(rot * 2.2) }]
  if (shape === 'flower') return [{ x: 0, y: 0, r: 0.3 }, ...around(6, 0.62, 0.27)]
  if (shape === 'row') {
    const c = Math.cos(rot - Math.PI / 4)
    const s = Math.sin(rot - Math.PI / 4)
    return [-0.6, 0, 0.6].map((d) => ({ x: c * d, y: s * d, r: 0.33 }))
  }
  if (shape === 'orbit') {
    const a = rot - Math.PI / 4
    return [
      { x: 0, y: 0, r: 0.48 },
      { x: Math.cos(a) * 0.78, y: Math.sin(a) * 0.78, r: 0.2 },
    ]
  }
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

type Pass = { circles: Prim[]; cx: number; cy: number; scale: number; color: string; angle: number; pitch: number; soft: number; seed: number; gain: number }

/** The box a prim can print inside, edge ramp included, so print can skip dots nowhere near it. */
function bounds(p: Prim, soft: number): [number, number, number, number] {
  if ('blob' in p) {
    const m = p.r * (1 + soft) + p.k
    return [Math.min(p.ax, p.bx) - m, Math.min(p.ay, p.by) - m, Math.max(p.ax, p.bx) + m, Math.max(p.ay, p.by) + m]
  }
  if ('tri' in p) {
    const [x0, y0, x1, y1, x2, y2] = p.tri
    const m = p.round * (1 + soft)
    return [Math.min(x0, x1, x2) - m, Math.min(y0, y1, y2) - m, Math.max(x0, x1, x2) + m, Math.max(y0, y1, y2) + m]
  }
  if ('x1' in p) {
    const m = p.r * (1 + soft)
    return [Math.min(p.x1, p.x2) - m, Math.min(p.y1, p.y2) - m, Math.max(p.x1, p.x2) + m, Math.max(p.y1, p.y2) + m]
  }
  const m = p.r * (1 + soft) * ('star' in p ? Math.max(1, p.sy) : 1)
  return [p.x - m, p.y - m, p.x + m, p.y + m]
}

function print(ctx: CanvasRenderingContext2D, o: Pass) {
  let bx0 = 1.15
  let by0 = 1.15
  let bx1 = -1.15
  let by1 = -1.15
  for (const c of o.circles) {
    if (c.cut) continue
    const [x0, y0, x1, y1] = bounds(c, o.soft)
    bx0 = Math.min(bx0, x0)
    by0 = Math.min(by0, y0)
    bx1 = Math.max(bx1, x1)
    by1 = Math.max(by1, y1)
  }
  bx0 = Math.max(bx0, -1.15)
  by0 = Math.max(by0, -1.15)
  bx1 = Math.min(bx1, 1.15)
  by1 = Math.min(by1, 1.15)
  if (bx0 > bx1 || by0 > by1) return
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
      if (dx < bx0 || dx > bx1 || dy < by0 || dy > by1) continue
      let tone = 0
      let cut = 0
      for (const c of o.circles) {
        const d = reach(c, dx, dy)
        const k = (1 - smooth((d - 1 + o.soft) / (2 * o.soft))) * (c.tone ?? 1)
        if (c.cut) cut = Math.max(cut, k)
        else tone = Math.max(tone, k)
      }
      tone *= 1 - cut
      if (tone < 0.03) continue
      tone *= (1 - 0.22 + 0.44 * hash(i, j, o.seed)) * o.gain
      const r = p * 0.5 * Math.sqrt(Math.min(1, tone)) * 1.12
      if (r < 0.22) continue
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
  ctx.fill()
}

/** clear: false lays this pass over what is already printed, for marks in more than one ink. */
type Press = { prims: Prim[]; size: number; theme: 'light' | 'dark'; dpr: number; ink: Ink; mis?: Ink; seed?: number; soft?: number; pitch?: number; clear?: boolean; angle?: number; gain?: number }

/** Prints any set of prims as one riso pass, plus an offset second plate when mis is set. */
export function press(ctx: CanvasRenderingContext2D, o: Press) {
  const inks = INKS[o.theme]
  const soft = o.soft ?? 0.16
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  if (o.clear !== false) ctx.clearRect(0, 0, o.size, o.size)
  ctx.globalCompositeOperation = o.theme === 'dark' ? 'screen' : 'multiply'
  const base = { circles: o.prims, scale: o.size / 2 - 1, pitch: o.pitch ?? Math.max(1.6, o.size / 12) }
  if (o.mis)
    print(ctx, { ...base, cx: o.size / 2 + Math.max(0.6, o.size / 30), cy: o.size / 2 + Math.max(0.4, o.size / 45), color: inks[o.mis], angle: SCREEN[o.mis], soft: soft + 0.05, seed: 3, gain: 0.55 })
  print(ctx, { ...base, cx: o.size / 2, cy: o.size / 2, color: inks[o.ink], angle: o.angle ?? SCREEN[o.ink], soft, seed: o.seed ?? 1, gain: o.gain ?? 1 })
}

type Paint = { agent: string; size: number; mode: MarkMode; theme: 'light' | 'dark'; dpr: number; t: number }

/** Draws one frame of an agent's mark into a canvas already sized to size * dpr. */
export function paintMark(ctx: CanvasRenderingContext2D, { agent, size, mode, theme, dpr, t }: Paint) {
  const id = markFor(agent)
  const seed = (nameHash(agent) % 97) + 1
  const idle = mode === 'idle'
  const rot = mode === 'working' ? t * 0.45 + seed : 0
  const soft = idle ? 0.3 : mode === 'waiting' ? 0.16 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.2)) : 0.16
  press(ctx, { prims: shapePrims(id, rot), size, theme, dpr, ink: idle ? 'ghost' : id.ink, mis: idle ? undefined : id.mis, seed, soft })
}

export function Mark({ agent, size, mode = 'still' }: { agent: string; size: number; mode?: MarkMode }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const theme = useContext(ThemeCtx)

  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = c.height = Math.round(size * dpr)
    const draw = (t: number) => paintMark(ctx, { agent, size, mode, theme, dpr, t })

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
