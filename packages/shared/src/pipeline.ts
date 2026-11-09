// The seam between the API (accepts captures) and the worker (turns them into raw docs).
// apps/api depends on these interfaces only; apps/worker implements them.
import type { CaptureStatus, FeedEvent, Side, SourceType } from "./types";

/** One capture on its way in. Exactly one of `text` or `audio` is set. */
export interface IngestJob {
  capture_id: string;
  team_id: string;
  who: string;
  type: SourceType;
  /** UTC ISO. When the capture started (recording start, or receive time for text). */
  at: string;
  /** UTC ISO. When the API received it. The SLO clock starts here. */
  received_at: string;
  source_ref?: string;
  /** Which half of the team it came from. Copied onto every raw doc. */
  side?: Side;
  text?: string;
  audio?: { data: Uint8Array; mime: string; filename?: string };
}

export interface TranscriptSegment {
  start_s: number;
  end_s: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  duration_s: number;
}

/** Swappable: OpenAI Whisper API today, local whisper.cpp later. Same interface. */
export interface Transcriber {
  readonly name: string;
  transcribe(audio: { data: Uint8Array; mime: string; filename?: string }): Promise<Transcript>;
}

/**
 * Accepts a job and returns immediately; the work happens after.
 * Inline (same process) for dev and v0; HTTP to the worker Deployment on the cluster.
 */
export interface Dispatcher {
  dispatch(job: IngestJob): Promise<CaptureStatus>;
  status(capture_id: string): Promise<CaptureStatus | undefined>;
  /** This process's recent captures for a team, newest first. Feeds the SLO numbers on the dashboard. */
  captures(team_id: string): Promise<CaptureStatus[]>;
  /** Push a non-capture event (e.g. a task claim) onto the team's live feed. */
  publish(team_id: string, event: FeedEvent): void;
  /** Live feed for SSE. Returns an unsubscribe function. */
  subscribe(team_id: string, listener: (event: FeedEvent) => void): () => void;
}
