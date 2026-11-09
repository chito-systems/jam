// Shared by the local bridge (bridge/server.ts) and the browser (src/ade/Terminal.tsx).
// Pure: no Node or DOM APIs, so vitest can run it and Vite can bundle it.

export const BRIDGE_PORT = 4317

const ALWAYS = new Set(['https://jam.cnh.radarhq.io'])
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/

// The bridge hands a shell to whoever connects, so only pages served by JAM may.
// Exact matches only: no Origin header, "null", and look-alike hosts are refused.
export function isAllowedOrigin(origin: string | undefined, extra = ''): boolean {
  if (!origin) return false
  if (LOCAL.test(origin) || ALWAYS.has(origin)) return true
  return extra
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(origin)
}

export type ClientMessage = { t: 'in'; d: string } | { t: 'resize'; cols: number; rows: number }

export const encodeInput = (d: string): string => JSON.stringify({ t: 'in', d })
export const encodeResize = (cols: number, rows: number): string => JSON.stringify({ t: 'resize', cols, rows })

const dim = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 1000

export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object') return null
  const o = m as Record<string, unknown>
  if (o.t === 'in' && typeof o.d === 'string') return { t: 'in', d: o.d }
  if (o.t === 'resize' && dim(o.cols) && dim(o.rows)) return { t: 'resize', cols: o.cols, rows: o.rows }
  return null
}
