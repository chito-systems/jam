// Snake, as pure functions. The component owns the clock, the canvas and the keys; this owns the rules.

export type Dir = 'up' | 'down' | 'left' | 'right'
export type Cell = { x: number; y: number }
export type Snake = {
  cols: number
  rows: number
  /** Head first. */
  body: Cell[]
  dir: Dir
  /** The direction the next step will take; set by turn, committed by step. */
  next: Dir
  food: Cell
  score: number
  over: boolean
}

const DELTA: Record<Dir, Cell> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y

/** Puts food on a random free cell. `random` returns [0, 1). Returns null when the board is full. */
export function placeFood(cols: number, rows: number, body: Cell[], random: () => number): Cell | null {
  const free: Cell[] = []
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (!body.some((c) => c.x === x && c.y === y)) free.push({ x, y })
  if (free.length === 0) return null
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))] ?? null
}

/** A three-long snake in the middle, heading right. */
export function newGame(cols: number, rows: number, random: () => number): Snake {
  const cy = Math.floor(rows / 2)
  const cx = Math.floor(cols / 2)
  const body = [
    { x: cx, y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
  ]
  const food = placeFood(cols, rows, body, random) ?? { x: 0, y: 0 }
  return { cols, rows, body, dir: 'right', next: 'right', food, score: 0, over: false }
}

/** Queues a turn. A 180-degree reversal (into your own neck) is ignored. */
export function turn(s: Snake, dir: Dir): Snake {
  if (s.over || dir === OPPOSITE[s.dir]) return s
  return { ...s, next: dir }
}

/** One tick: move, eat and grow, or die on a wall or yourself. */
export function step(s: Snake, random: () => number): Snake {
  if (s.over) return s
  const dir = s.next
  const head = s.body[0]
  if (!head) return { ...s, over: true }
  const d = DELTA[dir]
  const nh = { x: head.x + d.x, y: head.y + d.y }
  if (nh.x < 0 || nh.y < 0 || nh.x >= s.cols || nh.y >= s.rows) return { ...s, dir, over: true }
  const eats = same(nh, s.food)
  // The tail moves out of the way this tick unless we are growing.
  const rest = eats ? s.body : s.body.slice(0, -1)
  if (rest.some((c) => same(c, nh))) return { ...s, dir, over: true }
  const body = [nh, ...rest]
  if (!eats) return { ...s, body, dir }
  const food = placeFood(s.cols, s.rows, body, random)
  if (!food) return { ...s, body, dir, score: s.score + 1, over: true }
  return { ...s, body, dir, food, score: s.score + 1 }
}

/** Keys snake uses, by KeyboardEvent.key. */
export function keyDir(key: string): Dir | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'up'
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'down'
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'left'
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right'
    default:
      return null
  }
}

/** A swipe of at least `min` px, by its larger axis. */
export function swipeDir(dx: number, dy: number, min = 24): Dir | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return null
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'down' : 'up'
}
