// Writes the JAM app icons as SVG: the "jam" mark (three pink pairs, halftone) from src/ade/Mark.tsx,
// with the same circle and dot maths. Rasterize the results with macOS sips; see apps/web/README.md.
// Usage: node apps/web/scripts/icons.mjs <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PAPER = '#fbfaf6'
const INK = '#ff48b0'
const ANGLE = 75 // pink screen angle
const SOFT = 0.16

// shapeCircles('tri2', 0)
const circles = []
for (let k = 0; k < 3; k++) {
  const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3
  const cx = Math.cos(a) * 0.52
  const cy = Math.sin(a) * 0.52
  const tx = -Math.sin(a)
  const ty = Math.cos(a)
  circles.push({ x: cx + tx * 0.19, y: cy + ty * 0.19, r: 0.27 }, { x: cx - tx * 0.19, y: cy - ty * 0.19, r: 0.27 })
}

const hash = (i, j, s) => {
  const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453
  return v - Math.floor(v)
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
let seed = 2166136261
for (const ch of 'jam') seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619)
seed = ((seed >>> 0) % 97) + 1

/** The dots of print() for a mark of half-size `scale` centred on (c, c); pitch is size / 12 as in the app. */
function dots(c, scale) {
  const p = (2 * scale) / 12
  const a = (ANGLE * Math.PI) / 180
  const [cos, sin] = [Math.cos(a), Math.sin(a)]
  const n = Math.ceil((scale * 1.6 + p) / p) + 1
  const ui = Math.round((c * cos + c * sin) / p)
  const vi = Math.round((-c * sin + c * cos) / p)
  const out = []
  for (let i = ui - n; i <= ui + n; i++)
    for (let j = vi - n; j <= vi + n; j++) {
      const x = i * p * cos - j * p * sin
      const y = i * p * sin + j * p * cos
      const dx = (x - c) / scale
      const dy = (y - c) / scale
      if (Math.abs(dx) > 1.15 || Math.abs(dy) > 1.15) continue
      let tone = 0
      for (const k of circles) tone = Math.max(tone, 1 - smooth((Math.hypot(dx - k.x, dy - k.y) / k.r - 1 + SOFT) / (2 * SOFT)))
      if (tone < 0.03) continue
      tone *= 1 - 0.22 + 0.44 * hash(i, j, seed)
      const r = p * 0.5 * Math.sqrt(Math.min(1, tone)) * 1.12
      if (r < p * 0.11) continue
      out.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}"/>`)
    }
  return out.join('')
}

// The mark reaches about 0.87 of its half-size, so `fill` is the share of the canvas it covers.
const svg = (fill, paper) => {
  const S = 512
  const bg = paper ? `<rect width="${S}" height="${S}" fill="${PAPER}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}"><title>JAM</title>${bg}<g fill="${INK}">${dots(S / 2, (fill * S) / 2 / 0.87)}</g></svg>\n`
}

const out = process.argv[2] ?? '.'
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'favicon.svg'), svg(0.96, false))
writeFileSync(join(out, 'icon.svg'), svg(0.76, true))
writeFileSync(join(out, 'icon-maskable.svg'), svg(0.6, true)) // inside the 80% safe circle
writeFileSync(join(out, 'apple-touch-icon.svg'), svg(0.7, true))
