// Just enough markdown for a work order spec: headings, quotes, checkbox and bullet lists,
// paragraphs and code fences. Produces data, never HTML: the renderer writes it as React text.

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'quote'; text: string }
  | { t: 'checks'; items: { done: boolean; text: string }[] }
  | { t: 'list'; items: string[] }
  | { t: 'code'; text: string }
  | { t: 'p'; text: string }

export function parseMarkdown(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) body.push(lines[i++] ?? '')
      i++ // closing fence (or end of input)
      out.push({ t: 'code', text: body.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ t: 'h', level: h[1]?.length ?? 1, text: (h[2] ?? '').trim() })
      i++
      continue
    }
    if (line.startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) body.push((lines[i++] ?? '').replace(/^>\s?/, ''))
      out.push({ t: 'quote', text: body.join(' ').trim() })
      continue
    }
    if (/^\s*[-*]\s+\[[ xX]\]/.test(line)) {
      const items: { done: boolean; text: string }[] = []
      for (let m = CHECK.exec(lines[i] ?? ''); m; m = CHECK.exec(lines[++i] ?? '')) items.push({ done: m[1] !== ' ', text: (m[2] ?? '').trim() })
      out.push({ t: 'checks', items })
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '') && !CHECK.test(lines[i] ?? '')) items.push((lines[i++] ?? '').replace(/^\s*[-*]\s+/, '').trim())
      out.push({ t: 'list', items })
      continue
    }
    const body: string[] = []
    while (i < lines.length && (lines[i] ?? '').trim() && !STARTS_BLOCK.test(lines[i] ?? '')) body.push((lines[i++] ?? '').trim())
    out.push({ t: 'p', text: body.join(' ') })
  }
  return out
}

const CHECK = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/
const STARTS_BLOCK = /^(#{1,6}\s|>|```|\s*[-*]\s+)/

export type Span = { t: 'text' | 'code' | 'b'; text: string }

/** `code` and **bold**; everything else is plain text. */
export function inline(text: string): Span[] {
  const out: Span[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ t: 'text', text: text.slice(last, m.index) })
    out.push(m[1] !== undefined ? { t: 'code', text: m[1] } : { t: 'b', text: m[2] ?? '' })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', text: text.slice(last) })
  return out
}
