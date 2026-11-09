// Terminal tabs in the centre pane: pure logic (tested in sessions.test.ts).

export type Side = 'backend' | 'frontend'
export type Session = { id: string; title: string; kind: 'agent' | 'shell'; agentName?: string; side?: Side; run?: string }
export type Tabs = { list: Session[]; active: string | null }
export type TabAction = { t: 'add'; s: Session } | { t: 'close'; id: string } | { t: 'show'; id: string | null }

export const MAX_SESSIONS = 6
export const NO_TABS: Tabs = { list: [], active: null }

/** Lowercase letters, digits and dashes only, so the name is safe in a shell and valid for jam-agent.sh. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'me'

/** "<me>-opus-<n>" with the smallest n not taken by an open tab or a known agent. */
export function nextAgentName(me: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = `${slug(me)}-opus-`
  let n = 1
  while (used.has(`${base}${n}`)) n++
  return `${base}${n}`
}

/** "shell", then "shell 2", "shell 3"… skipping titles still open. */
export function nextShellTitle(list: Session[]): string {
  const used = new Set(list.map((s) => s.title))
  if (!used.has('shell')) return 'shell'
  let n = 2
  while (used.has(`shell ${n}`)) n++
  return `shell ${n}`
}

/** Single-quote for POSIX shells. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** What gets typed into a new agent's shell. `dry` echoes instead, for tests and demos without a paid session. */
export function agentCommand(origin: string, team: string, name: string, side: Side, dry = false): string {
  if (dry) return `echo AGENT ${shq(name)}`
  return `JAM_URL=${shq(origin)} JAM_TEAM=${shq(team)} ./scripts/jam-agent.sh ${shq(name)} ${shq(side)}`
}

/** "cam-opus-1" for cam → "opus-1". */
export const agentTitle = (name: string, me: string): string => {
  const p = `${slug(me)}-`
  return name.startsWith(p) && name.length > p.length ? name.slice(p.length) : name
}

export function tabsReducer(s: Tabs, a: TabAction): Tabs {
  switch (a.t) {
    case 'add':
      if (s.list.length >= MAX_SESSIONS || s.list.some((x) => x.id === a.s.id)) return s
      return { list: [...s.list, a.s], active: a.s.id }
    case 'close': {
      const i = s.list.findIndex((x) => x.id === a.id)
      if (i < 0) return s
      const list = s.list.filter((x) => x.id !== a.id)
      if (s.active !== a.id) return { ...s, list }
      return { list, active: (list[i] ?? list[i - 1])?.id ?? null }
    }
    case 'show':
      if (a.id !== null && !s.list.some((x) => x.id === a.id)) return s
      return { ...s, active: a.id }
  }
}
