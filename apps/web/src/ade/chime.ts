// Soft synthesized chimes. No audio files: each note is a sine fundamental plus one quieter
// overtone (4x reads as marimba, 2.76x as bell), with a fast attack and an exponential decay.
// Nothing touches the browser at import time, so tests can import the tables.

export type ChimeName = 'start' | 'sent' | 'cancel' | 'error' | 'done'
/** f: Hz · t: start offset in s · d: decay in s · g: level, 0 to 1. */
export type Note = { f: number; t: number; d: number; g?: number }
export type Chime = { overtone: number; notes: Note[] }

export const PEAK = 0.15

export const CHIMES: Record<ChimeName, Chime> = {
  start: { overtone: 4, notes: [{ f: 1318.5, t: 0, d: 0.12 }, { f: 1760, t: 0.06, d: 0.16 }] },
  sent: { overtone: 4, notes: [{ f: 1046.5, t: 0, d: 0.2 }, { f: 1318.5, t: 0.06, d: 0.2 }, { f: 1568, t: 0.12, d: 0.3 }] },
  cancel: { overtone: 4, notes: [{ f: 784, t: 0, d: 0.16, g: 0.7 }, { f: 587.3, t: 0.08, d: 0.22, g: 0.7 }] },
  error: { overtone: 2, notes: [{ f: 220, t: 0, d: 0.2, g: 0.9 }, { f: 207.7, t: 0.16, d: 0.3, g: 0.9 }] },
  done: {
    overtone: 2.76,
    notes: [
      { f: 784, t: 0, d: 0.25, g: 0.7 },
      { f: 1046.5, t: 0.09, d: 0.25, g: 0.7 },
      { f: 1318.5, t: 0.18, d: 0.3, g: 0.75 },
      { f: 2093, t: 0.3, d: 0.9 },
    ],
  },
}

// ---------- the sound setting ----------

const KEY = 'jam-sound'
let enabled: boolean | undefined

export function soundOn(): boolean {
  if (enabled !== undefined) return enabled
  try {
    enabled = localStorage.getItem(KEY) !== 'off'
  } catch (e) {
    console.warn(`reading ${KEY} failed; sound stays on`, e)
    enabled = true
  }
  return enabled
}

export function setSound(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch (e) {
    console.warn(`saving ${KEY} failed; the setting lasts for this tab`, e)
  }
}

// ---------- one shared AudioContext, created and resumed on the first gesture ----------

let ctx: AudioContext | null = null

/** The shared context, or null before the first gesture or when WebAudio is missing. */
export const audioContext = (): AudioContext | null => ctx

/** Call once from an effect. Returns the cleanup. */
export function armAudio(): () => void {
  const go = () => {
    off()
    if (ctx || typeof AudioContext === 'undefined') return
    try {
      ctx = new AudioContext()
      ctx.resume().catch((e: unknown) => console.error('resuming audio failed; chimes stay silent', e))
    } catch (e) {
      console.error('WebAudio is unavailable; chimes stay silent', e)
    }
  }
  const off = () => {
    window.removeEventListener('pointerdown', go, true)
    window.removeEventListener('keydown', go, true)
  }
  window.addEventListener('pointerdown', go, true)
  window.addEventListener('keydown', go, true)
  return off
}

/** Silent until audio is unlocked, and when sound is off. Never throws. */
/** Inside the JAM iPhone app, every chime is also felt: the native shell plays a haptic. */
function haptic(name: ChimeName): void {
  if (typeof window === 'undefined') return
  const w = window as Window & { webkit?: { messageHandlers?: { jam?: { postMessage: (m: unknown) => void } } } }
  w.webkit?.messageHandlers?.jam?.postMessage({ haptic: name })
}

export function playChime(name: ChimeName): void {
  haptic(name)
  const c = ctx
  if (c?.state !== 'running' || !soundOn()) return
  try {
    const { overtone, notes } = CHIMES[name]
    const t0 = c.currentTime + 0.01
    for (const n of notes) {
      for (const [ratio, level, decay] of [[1, 1, n.d], [overtone, 0.2, n.d / 3]] as const) {
        const at = t0 + n.t
        const o = c.createOscillator()
        const g = c.createGain()
        o.frequency.value = n.f * ratio
        g.gain.setValueAtTime(0.0001, at)
        g.gain.exponentialRampToValueAtTime(PEAK * 0.8 * (n.g ?? 1) * level, at + 0.006)
        g.gain.exponentialRampToValueAtTime(0.0001, at + decay)
        o.connect(g).connect(c.destination)
        o.start(at)
        o.stop(at + decay + 0.02)
      }
    }
  } catch (e) {
    console.error(`playing the ${name} chime failed`, e)
  }
}
