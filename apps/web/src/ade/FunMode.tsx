import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type Dir, keyDir, newGame, type Snake, step, swipeDir, turn } from './snake'
import './fun.css'

// Fun mode: the distraction lives inside the tool, so people stay near their agents.
// Capture is the default and changes nothing; Fun opens a tiny browser with snake and a link out.

type Tab = 'snake' | 'instagram'

const COLS = 16
const ROWS = 16
const TICK_MS = 120
const BEST_KEY = 'hh.fun.best'

/** The header switch. Fun mounts the mini browser; closing it flips back to Capture. */
export function FunMode() {
  const [fun, setFun] = useState(false)
  return (
    <>
      <fieldset className="fun-seg" aria-label="Mode">
        <button type="button" aria-pressed={!fun} onClick={() => setFun(false)}>
          Capture
        </button>
        <button type="button" aria-pressed={fun} onClick={() => setFun(true)}>
          Fun
        </button>
      </fieldset>
      {fun && createPortal(<MiniBrowser onClose={() => setFun(false)} />, document.body)}
    </>
  )
}

function MiniBrowser({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('snake')
  const [off, setOff] = useState({ x: 0, y: 0 })
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { px: e.clientX, py: e.clientY, x: off.x, y: off.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    setOff({ x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py })
  }
  const up = () => {
    drag.current = null
  }

  return (
    <section className="fun-win" role="dialog" aria-label="Fun" style={{ transform: `translate(${off.x}px, ${off.y}px)` }}>
      <div className="fun-title" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <span className="fun-dots">
          <button type="button" className="fun-dot close" aria-label="Close fun mode" title="Close" onClick={onClose} />
          <i className="fun-dot" />
          <i className="fun-dot" />
        </span>
        <span className="fun-name">
          <b>fun</b>
          <small>for while your agents work</small>
        </span>
      </div>
      <div className="fun-tabs" role="tablist">
        {(['snake', 'instagram'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="fun-addr">{tab === 'snake' ? 'jam://fun/snake' : 'instagram.com'}</div>
      <div className="fun-body">{tab === 'snake' ? <SnakeGame /> : <Instagram />}</div>
    </section>
  )
}

function Instagram() {
  return (
    <div className="fun-card">
      <b>Instagram</b>
      <p>Instagram won't load inside a frame. Opens in its own window.</p>
      <button type="button" onClick={() => window.open('https://www.instagram.com/', '_blank', 'noopener')}>
        Open Instagram
      </button>
    </div>
  )
}

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0
  } catch (e) {
    console.warn('reading the snake best score failed; starting from 0', e)
    return 0
  }
}

function saveBest(n: number) {
  try {
    localStorage.setItem(BEST_KEY, String(n))
  } catch (e) {
    console.warn('saving the snake best score failed', e)
  }
}

/** Keys typed into a field, the terminal, or the Talk combo are never snake's. */
function ignored(e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey || e.ctrlKey) return true
  const t = e.target
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (t.closest('input, textarea, select, [contenteditable], .xterm')) return true
  return false
}

type Phase = 'ready' | 'run' | 'over'

function SnakeGame() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const game = useRef<Snake>(newGame(COLS, ROWS, Math.random))
  const [phase, setPhase] = useState<Phase>('ready')
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(readBest)
  const touch = useRef<{ x: number; y: number } | null>(null)

  const draw = useCallback(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const css = getComputedStyle(c)
    const ink = css.getPropertyValue('--ink').trim() || '#1a1818'
    const line = css.getPropertyValue('--line').trim() || '#e8e4da'
    const red = css.getPropertyValue('--red').trim() || '#bd2f1a'
    const size = c.clientWidth
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(size * dpr)) {
      c.width = Math.round(size * dpr)
      c.height = Math.round(size * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    const cell = size / COLS
    ctx.fillStyle = line
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) ctx.fillRect(x * cell + cell / 2 - 1, y * cell + cell / 2 - 1, 2, 2)
    const g = game.current
    ctx.fillStyle = red
    ctx.beginPath()
    ctx.arc(g.food.x * cell + cell / 2, g.food.y * cell + cell / 2, cell * 0.32, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = ink
    g.body.forEach((p, i) => {
      const inset = i === 0 ? 1 : 2
      ctx.beginPath()
      ctx.roundRect(p.x * cell + inset, p.y * cell + inset, cell - inset * 2, cell - inset * 2, 3)
      ctx.fill()
    })
  }, [])

  const restart = useCallback(() => {
    game.current = newGame(COLS, ROWS, Math.random)
    setScore(0)
    setPhase('ready')
    draw()
  }, [draw])

  const steer = useCallback((d: Dir) => {
    game.current = turn(game.current, d)
    setPhase((p) => (p === 'ready' ? 'run' : p))
  }, [])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    if (phase !== 'run') return
    const t = setInterval(() => {
      const g = step(game.current, Math.random)
      game.current = g
      setScore(g.score)
      if (g.over) {
        setPhase('over')
        setBest((b) => {
          if (g.score <= b) return b
          saveBest(g.score)
          return g.score
        })
      }
      draw()
    }, TICK_MS)
    return () => clearInterval(t)
  }, [phase, draw])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (ignored(e)) return
      if (phase === 'over') {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          restart()
        }
        return
      }
      const d = keyDir(e.key)
      if (!d) return
      e.preventDefault()
      steer(d)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [phase, restart, steer])

  return (
    <div className="fun-snake">
      <div className="fun-score">
        <span>
          score <b>{score}</b>
        </span>
        <span>
          best <b>{Math.max(best, score)}</b>
        </span>
      </div>
      <div
        className="fun-board"
        onTouchStart={(e) => {
          const t = e.touches[0]
          if (t) touch.current = { x: t.clientX, y: t.clientY }
        }}
        onTouchEnd={(e) => {
          const s = touch.current
          const t = e.changedTouches[0]
          touch.current = null
          if (!s || !t) return
          if (phase === 'over') return restart()
          const d = swipeDir(t.clientX - s.x, t.clientY - s.y)
          if (d) steer(d)
        }}
      >
        <canvas ref={canvas} aria-label="Snake board" />
        {phase === 'ready' && <p className="fun-msg">press any arrow to start</p>}
        {phase === 'over' && (
          <p className="fun-msg over">
            game over. <kbd>space</kbd> to go again
          </p>
        )}
      </div>
    </div>
  )
}
