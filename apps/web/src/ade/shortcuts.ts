// The keyboard shortcuts, in one table. The cheat sheet renders it and the handler matches
// against it, so the two can never disagree.

export type ShortcutId = 'cheat' | 'settings' | 'feed' | 'jam' | 'ship' | 'decisions' | 'shell' | 'agent' | 'tab' | 'search' | 'escape'
export type Group = 'Navigate' | 'Tabs' | 'Capture' | 'General'

/** `seq` is what the handler matches ("g f" is g, then f within SEQ_MS). No `id` means another feature owns the key. */
export type Shortcut = { id?: ShortcutId; seq?: string; keys: string[]; label: string; group: Group }

/** Option+Space, owned by Talk.tsx. Listed here so the cheat sheet shows it; never matched here. */
export const TALK_KEYS = ['⌥', 'Space']

export const SHORTCUTS: Shortcut[] = [
  { id: 'feed', seq: 'g f', keys: ['g', 'f'], label: 'Team feed', group: 'Navigate' },
  { id: 'jam', seq: 'g j', keys: ['g', 'j'], label: 'jam view', group: 'Navigate' },
  { id: 'ship', seq: 'g s', keys: ['g', 's'], label: 'Ship pane', group: 'Navigate' },
  { id: 'decisions', seq: 'g d', keys: ['g', 'd'], label: 'Open the decision log', group: 'Navigate' },
  { keys: ['j', 'k'], label: 'Next or previous task', group: 'Navigate' },
  { id: 'search', seq: '/', keys: ['/'], label: 'Search the brain', group: 'Navigate' },
  { id: 'shell', seq: 't', keys: ['t'], label: 'New shell tab', group: 'Tabs' },
  { id: 'agent', seq: 'a', keys: ['a'], label: 'New agent tab', group: 'Tabs' },
  { id: 'tab', keys: ['1', '…', '9'], label: 'Go to tab 1 to 9', group: 'Tabs' },
  { keys: TALK_KEYS, label: 'Hold to talk', group: 'Capture' },
  { keys: ['⌘', 'K'], label: 'Commands and tasks', group: 'General' },
  { id: 'settings', seq: ',', keys: [','], label: 'Settings (also ⌘,)', group: 'General' },
  { id: 'cheat', seq: '?', keys: ['?'], label: 'Keyboard shortcuts', group: 'General' },
  { id: 'escape', seq: 'Escape', keys: ['Esc'], label: 'Close what is open', group: 'General' },
]

export const GROUPS: Group[] = ['Navigate', 'Tabs', 'Capture', 'General']

/** How long "g" waits for its second key. */
export const SEQ_MS = 1000

/** The keys to show for a shortcut id, for the command palette hints. */
export function keysFor(id: ShortcutId): string {
  return SHORTCUTS.find((s) => s.id === id)?.keys.join(' ') ?? ''
}

export type Step = { action?: ShortcutId; tab?: number; pending: number | null; handled: boolean }

/** One key through the state machine. `pending` is when "g" was pressed, or null. */
export function step(key: string, pending: number | null, now: number): Step {
  if (pending !== null && now - pending <= SEQ_MS) {
    const hit = SHORTCUTS.find((s) => s.seq === `g ${key}`)
    return hit?.id ? { action: hit.id, pending: null, handled: true } : { pending: null, handled: false }
  }
  if (key === 'g') return { pending: now, handled: true }
  if (/^[1-9]$/.test(key)) return { action: 'tab', tab: Number(key), pending: null, handled: true }
  const hit = SHORTCUTS.find((s) => s.seq === key && !s.seq.startsWith('g '))
  return hit?.id ? { action: hit.id, pending: null, handled: true } : { pending: null, handled: false }
}

type TargetLike = { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null

/** Keys typed into a field, a terminal or the fun-mode game belong to them, never to app shortcuts. */
export function typingIn(t: TargetLike): boolean {
  if (!t) return false
  if (t.isContentEditable) return true
  if (t.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return true
  return Boolean(t.closest?.('input, textarea, select, [contenteditable], .xterm, .fun-win'))
}

/** Modifier keys belong to the browser, Talk (⌥Space) and the palette (⌘K). Only ⌘, is ours. */
export function modsOff(e: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  return !e.altKey && !e.metaKey && !e.ctrlKey
}
