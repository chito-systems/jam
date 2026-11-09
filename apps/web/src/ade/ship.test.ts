import { describe, expect, it } from 'vitest'
import { gitarVerdict, prUrl, shipHeader, shipRows } from './ship'

const ref = 'https://github.com/chito-systems/jam/pull/60'
const pr = (text: string, at: string, extra: { side?: string } = {}) => ({ type: 'pr' as const, who: 'github', text, at, source_ref: ref, ...extra })
const rv = (text: string, at: string) => ({ type: 'review' as const, who: 'gitar', text, at, source_ref: 'https://github.com/chito-systems/jam/pull/60#issuecomment-1' })

describe('ship', () => {
  it('reads the Gitar verdict', () => {
    expect(gitarVerdict('Gitar review on PR #60: Code Review 👍 Approved with suggestions 0 closed / 1 findings 🟡 Medium risk')).toBe('Suggestions')
    expect(gitarVerdict('Gitar review on PR #60: ⚠️ Changes requested')).toBe('Changes requested')
    expect(gitarVerdict('Gitar review on PR #60: Approved')).toBe('Approved')
    expect(gitarVerdict('Gitar review on PR #60: looking')).toBe('Reviewing')
  })

  it('derives the PR link from any GitHub URL', () => {
    expect(prUrl('https://github.com/chito-systems/jam/issues/1#c', 7)).toBe('https://github.com/chito-systems/jam/pull/7')
    expect(prUrl(undefined, 7)).toBeUndefined()
  })

  it('groups docs by PR, newest first, with the latest review', () => {
    const rows = shipRows(
      [
        pr('PR #60 opened by chito-systems: feat(web): terminal tabs \nbody text', '2026-11-09T15:00:00Z', { side: 'frontend' }),
        pr('PR #60 merged: feat(web): terminal tabs', '2026-11-09T16:00:00Z'),
        pr('Comment on #60: nice', '2026-11-09T15:30:00Z'),
        pr('PR #61 opened by cam: fix: thing', '2026-11-09T17:00:00Z'),
        pr('something unrelated', '2026-11-09T18:00:00Z'),
      ],
      [rv('Gitar review on PR #60: ⚠️ Changes requested', '2026-11-09T15:10:00Z'), rv('Gitar review on PR #60: Code Review 👍 Approved with suggestions 0 closed / 1 findings', '2026-11-09T15:40:00Z')],
    )
    expect(rows.map((r) => r.n)).toEqual([61, 60])
    expect(rows[1]).toMatchObject({ title: 'feat(web): terminal tabs', who: 'chito-systems', state: 'Merged', gitar: 'Suggestions', side: 'frontend', url: ref })
    expect(rows[0]).toMatchObject({ state: 'Open', who: 'cam' })
    expect(rows[0]?.gitar).toBeUndefined()
    expect(shipHeader(rows)).toBe('1 merged today · 1 reviewed by Gitar')
  })
})
