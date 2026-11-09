// A hold-to-talk voice clip: the rules and the upload, matching the /c capture page.
import type { IngestResponse } from '@hh/shared'

/** Shorter holds are taps, not speech: discarded with a hint. */
export const MIN_CLIP_MS = 500
export const tooShort = (ms: number) => ms < MIN_CLIP_MS

/** First container the browser can record, or '' to let it choose. */
export function pickMime(supported: (mime: string) => boolean): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(supported) ?? ''
}

/** "voice-2026-11-09T21-14-03-120Z.webm", named for when recording started. */
export function clipName(at: string, type: string): string {
  return `voice-${at.replace(/[:.]/g, '-')}.${/mp4|aac|m4a/.test(type) ? 'mp4' : 'webm'}`
}

/** Why this page cannot record, in one sentence, or null when it can. */
export function micProblem(env: { secure: boolean; media: boolean; recorder: boolean }): string | null {
  if (!env.secure) return 'The microphone needs https or localhost, and this page is on plain http.'
  if (!env.media || !env.recorder) return 'This browser cannot record audio. Notes below still work.'
  return null
}

export async function uploadClip(id: { team: string; who: string }, blob: Blob, at: string): Promise<IngestResponse> {
  const fd = new FormData()
  fd.append('team_id', id.team)
  fd.append('who', id.who)
  fd.append('type', 'voice')
  fd.append('at', at)
  fd.append('file', blob, clipName(at, blob.type))
  const res = await fetch('/api/ingest', { method: 'POST', body: fd })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `ingest answered ${res.status}`)
  }
  return (await res.json()) as IngestResponse
}
