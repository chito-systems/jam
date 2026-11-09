import type { RawDoc } from '@hh/shared'

// The Ship view: today's pull requests and what Gitar said, rebuilt from the GitHub activity
// the API already ingests into the brain (raw docs of type "pr" and "review").

export type PrState = 'Merged' | 'Open'
export type Gitar = 'Approved' | 'Suggestions' | 'Changes requested' | 'Reviewing'
export type ShipRow = { n: number; title: string; who?: string; state: PrState; gitar?: Gitar; side?: string; url?: string; at: string }

type ShipDoc = Pick<RawDoc, 'type' | 'text' | 'who' | 'at'> & { source_ref?: string; side?: string | null }

const OPENED = /^PR #(\d+) opened by ([^:\n]+):\s*([^\n]*)/i
const MERGED = /^PR #(\d+) merged:\s*([^\n]*)/i
const ANY_PR = /(?:PR #|#)(\d+)/i
const REVIEW = /review on PR #(\d+)/i
const REPO = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i

/** Approved / Suggestions / Changes requested from a Gitar review's text; Reviewing when it says neither. */
export function gitarVerdict(text: string): Gitar {
  if (/changes requested/i.test(text)) return 'Changes requested'
  if (/approved with suggestions/i.test(text)) return 'Suggestions'
  if (/approved/i.test(text)) return 'Approved'
  return 'Reviewing'
}

/** https://github.com/<owner>/<repo>/pull/<n>, from any GitHub URL for that repo. */
export function prUrl(ref: string | undefined, n: number): string | undefined {
  const m = ref?.match(REPO)
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${n}` : undefined
}

/** One row per PR number, newest first. Docs that name no PR are ignored. */
export function shipRows(prs: ShipDoc[], reviews: ShipDoc[]): ShipRow[] {
  const rows = new Map<number, ShipRow & { reviewAt?: string }>()
  const row = (n: number, at: string) => {
    let r = rows.get(n)
    if (!r) {
      r = { n, title: '', state: 'Open', at }
      rows.set(n, r)
    }
    if (at > r.at) r.at = at
    return r
  }
  for (const d of prs) {
    const text = d.text.trim()
    const opened = text.match(OPENED)
    const merged = text.match(MERGED)
    const n = Number((opened ?? merged ?? text.match(ANY_PR))?.[1])
    if (!n) continue
    const r = row(n, d.at)
    if (opened) {
      r.who = opened[2]?.trim()
      r.title ||= opened[3]?.trim() ?? ''
    }
    if (merged) {
      r.state = 'Merged'
      r.title = merged[2]?.trim() || r.title
    }
    r.url ??= prUrl(d.source_ref, n)
    r.side ??= d.side ?? undefined
  }
  for (const d of reviews) {
    const n = Number(d.text.match(REVIEW)?.[1] ?? d.text.match(ANY_PR)?.[1])
    if (!n) continue
    const r = row(n, d.at)
    if (!r.reviewAt || d.at >= r.reviewAt) {
      r.reviewAt = d.at
      r.gitar = gitarVerdict(d.text)
    }
    r.url ??= prUrl(d.source_ref, n)
  }
  return [...rows.values()]
    .map(({ reviewAt: _, ...r }) => ({ ...r, title: r.title || `PR #${r.n}` }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.n - a.n))
}

/** "<N> merged today · <M> reviewed by Gitar". */
export function shipHeader(rows: ShipRow[]): string {
  return `${rows.filter((r) => r.state === 'Merged').length} merged today · ${rows.filter((r) => r.gitar).length} reviewed by Gitar`
}
