import { describe, expect, it } from 'vitest'
import { inline, parseMarkdown } from './md'

// The shape jam's planner writes (apps/worker/src/planner.ts renderWorkOrder).
const SPEC = [
  '## Goal',
  'Show proposed work orders above the feed.',
  '',
  "## Why (from the team's own words)",
  '> "Jake, can you make the work orders obvious" — cam, 2:14 PM (`c1:0`)',
  '',
  '> "and copyable" — jake, 2:15 PM (`c2:0`)',
  '',
  '## Acceptance criteria',
  '- [ ] Orders show before working tasks',
  '- [x] Accept moves the card',
  '',
  '## Constraints',
  '- Open a PR; never push to main',
].join('\n')

describe('parseMarkdown', () => {
  it('reads a planner spec into headings, separate quotes, a checklist and a list', () => {
    expect(parseMarkdown(SPEC)).toEqual([
      { t: 'h', level: 2, text: 'Goal' },
      { t: 'p', text: 'Show proposed work orders above the feed.' },
      { t: 'h', level: 2, text: "Why (from the team's own words)" },
      { t: 'quote', text: '"Jake, can you make the work orders obvious" — cam, 2:14 PM (`c1:0`)' },
      { t: 'quote', text: '"and copyable" — jake, 2:15 PM (`c2:0`)' },
      { t: 'h', level: 2, text: 'Acceptance criteria' },
      { t: 'checks', items: [{ done: false, text: 'Orders show before working tasks' }, { done: true, text: 'Accept moves the card' }] },
      { t: 'h', level: 2, text: 'Constraints' },
      { t: 'list', items: ['Open a PR; never push to main'] },
    ])
  })

  it('joins wrapped paragraph lines, keeps code fences verbatim and survives an unclosed fence', () => {
    expect(parseMarkdown('one\ntwo\n\n```\n<b>x</b>\n  y\n```\nthree')).toEqual([
      { t: 'p', text: 'one two' },
      { t: 'code', text: '<b>x</b>\n  y' },
      { t: 'p', text: 'three' },
    ])
    expect(parseMarkdown('```\nopen')).toEqual([{ t: 'code', text: 'open' }])
  })

  it('splits a checklist from a plain list that follows it', () => {
    expect(parseMarkdown('- [ ] a\n- b')).toEqual([
      { t: 'checks', items: [{ done: false, text: 'a' }] },
      { t: 'list', items: ['b'] },
    ])
  })

  it('treats U+2028, U+2029 and lone \\r as line breaks instead of hanging', () => {
    expect(parseMarkdown('# Goal\u2028do it')).toEqual([
      { t: 'h', level: 1, text: 'Goal' },
      { t: 'p', text: 'do it' },
    ])
    expect(parseMarkdown('- [ ] a\u2029b\r- [x] c')).toEqual([
      { t: 'checks', items: [{ done: false, text: 'a' }] },
      { t: 'p', text: 'b' },
      { t: 'checks', items: [{ done: true, text: 'c' }] },
    ])
    expect(parseMarkdown('## \u2028\u2028> q')).toEqual([{ t: 'h', level: 2, text: '' }, { t: 'quote', text: 'q' }])
  })

  it('closes an unterminated quote or list at the end of input', () => {
    expect(parseMarkdown('> "said it')).toEqual([{ t: 'quote', text: '"said it' }])
    expect(parseMarkdown('- a\n- b')).toEqual([{ t: 'list', items: ['a', 'b'] }])
    expect(parseMarkdown('- [ ] a\n- [ ]')).toEqual([{ t: 'checks', items: [{ done: false, text: 'a' }, { done: false, text: '' }] }])
  })

  it('parses 5,000 lines of mixed, hostile input quickly', () => {
    const kinds = ['# h\u2028x', '> q\u2029', '- [ ] c', '- l', 'para', '', '```', '#\u2028', '-\u2028[ ]']
    const big = Array.from({ length: 5000 }, (_, n) => kinds[n % kinds.length]).join('\n')
    const t = performance.now()
    expect(parseMarkdown(big).length).toBeGreaterThan(0)
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('returns nothing for blank input', () => {
    expect(parseMarkdown('\n  \n')).toEqual([])
  })
})

describe('inline', () => {
  it('splits code and bold out of plain text; HTML stays text', () => {
    expect(inline('see `a.ts` and **this** <img>')).toEqual([
      { t: 'text', text: 'see ' },
      { t: 'code', text: 'a.ts' },
      { t: 'text', text: ' and ' },
      { t: 'b', text: 'this' },
      { t: 'text', text: ' <img>' },
    ])
  })
})
