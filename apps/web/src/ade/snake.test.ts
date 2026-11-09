import { describe, expect, it } from 'vitest'
import { keyDir, newGame, placeFood, type Snake, step, swipeDir, turn } from './snake'

const zero = () => 0

function game(over: Partial<Snake> = {}): Snake {
  return { ...newGame(10, 10, zero), ...over }
}

describe('snake', () => {
  it('starts three long, heading right, with food off the body', () => {
    const s = newGame(10, 10, zero)
    expect(s.body).toEqual([
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ])
    expect(s.dir).toBe('right')
    expect(s.body).not.toContainEqual(s.food)
  })

  it('steps forward one cell and keeps its length', () => {
    const s = step(game({ food: { x: 0, y: 0 } }), zero)
    expect(s.body).toEqual([
      { x: 6, y: 5 },
      { x: 5, y: 5 },
      { x: 4, y: 5 },
    ])
    expect(s.over).toBe(false)
  })

  it('ignores a 180-degree reversal but takes a quarter turn', () => {
    const s = game()
    expect(turn(s, 'left')).toBe(s)
    const t = step(turn(s, 'up'), zero)
    expect(t.body[0]).toEqual({ x: 5, y: 4 })
    expect(t.dir).toBe('up')
  })

  it('eats, grows by one, scores, and places new food from the injected random', () => {
    const s = step(game({ food: { x: 6, y: 5 } }), zero)
    expect(s.body).toHaveLength(4)
    expect(s.score).toBe(1)
    expect(s.food).toEqual({ x: 0, y: 0 })
  })

  it('dies on a wall', () => {
    const s = step(game({ body: [{ x: 9, y: 0 }], food: { x: 0, y: 9 } }), zero)
    expect(s.over).toBe(true)
  })

  it('dies on itself, but chasing its own tail is fine', () => {
    // A 2x2 loop: head at (1,0) heading down into (1,1) which is the tail and moves away.
    const loop = game({
      body: [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
      dir: 'right',
      next: 'down',
      food: { x: 9, y: 9 },
    })
    expect(step(loop, zero).over).toBe(false)
    const five = { ...loop, body: [...loop.body, { x: 2, y: 1 }] }
    expect(step(five, zero).over).toBe(true)
  })

  it('places food only on free cells, and says so when there are none', () => {
    const body = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]
    expect(placeFood(2, 2, body, zero)).toEqual({ x: 0, y: 1 })
    expect(placeFood(2, 2, body, () => 0.99)).toEqual({ x: 1, y: 1 })
    expect(placeFood(2, 1, body, zero)).toBeNull()
  })

  it('maps arrows, WASD and swipes', () => {
    expect(keyDir('ArrowUp')).toBe('up')
    expect(keyDir('a')).toBe('left')
    expect(keyDir('x')).toBeNull()
    expect(swipeDir(40, 5)).toBe('right')
    expect(swipeDir(-3, -50)).toBe('up')
    expect(swipeDir(5, 5)).toBeNull()
  })
})
