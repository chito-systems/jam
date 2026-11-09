import type { TranscriptSegment } from "@hh/shared";

export interface TimedChunk {
  start_s: number;
  end_s: number;
  text: string;
}

/** Packs pieces greedily into strings of at most `maxChars` (a single oversized piece stays whole). */
function pack(pieces: string[], sep: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + sep.length + piece.length <= maxChars) {
      current += sep + piece;
    } else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Hard-splits text with no usable sentence boundary. Last resort. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    const part = text.slice(i, i + maxChars).trim();
    if (part) out.push(part);
  }
  return out;
}

/** Splits on blank lines, then on sentence ends when a paragraph is too long; packs greedily. */
export function chunkText(text: string, maxChars = 1200): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  let fitting: string[] = [];
  const flush = () => {
    out.push(...pack(fitting, "\n\n", maxChars));
    fitting = [];
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      fitting.push(paragraph);
      continue;
    }
    flush();
    const sentences = paragraph
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((s) => (s.length > maxChars ? hardSplit(s, maxChars) : [s]));
    out.push(...pack(sentences, " ", maxChars));
  }
  flush();
  return out;
}

/** Merges consecutive Whisper segments into windows of at most ~`maxWindowS` seconds. */
export function chunkSegments(segments: TranscriptSegment[], maxWindowS = 30): TimedChunk[] {
  const out: TimedChunk[] = [];
  let current: TimedChunk | undefined;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    if (current && seg.end_s - current.start_s <= maxWindowS) {
      current.end_s = seg.end_s;
      current.text += ` ${text}`;
      continue;
    }
    if (current) out.push(current);
    current = { start_s: seg.start_s, end_s: seg.end_s, text };
  }
  if (current) out.push(current);
  return out;
}
