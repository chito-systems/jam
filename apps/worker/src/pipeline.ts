import {
  type ContextStore,
  type IngestJob,
  type RawDoc,
  RawDocSchema,
  type Transcriber,
  type Transcript,
  withSpan,
} from "@hh/shared";
import { chunkSegments, chunkText } from "./chunk";

export interface PipelineDeps {
  store: ContextStore;
  /** Absent = text-only (voice captures fail with a clear error). */
  transcriber?: Transcriber;
  /** CHAOS_MODE: adds latency and failures to the index step. Off unless exactly true. */
  chaos?: boolean;
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to Math.random. */
  random?: () => number;
}

export type PipelineStep = "transcribe" | "chunk" | "index";

/** Carries the step that failed so the dispatcher can log it once, at the boundary. */
export class PipelineError extends Error {
  constructor(
    readonly step: PipelineStep,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PipelineError";
  }
}

export const CHAOS_DELAY_MS = 3000;
export const CHAOS_FAILURE_RATE = 0.2;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function transcribe(job: IngestJob, deps: PipelineDeps): Promise<Transcript> {
  return withSpan("ingest.transcribe", { capture_id: job.capture_id }, async (span) => {
    if (!deps.transcriber) throw new Error("no transcriber configured (set OPENAI_API_KEY)");
    if (!job.audio) throw new Error("voice job has no audio");
    span.setAttribute("transcriber", deps.transcriber.name);
    const transcript = await deps.transcriber.transcribe(job.audio);
    span.setAttribute("segments", transcript.segments.length);
    return transcript;
  });
}

function chunk(job: IngestJob, transcript: Transcript | undefined): Promise<RawDoc[]> {
  return withSpan("ingest.chunk", { capture_id: job.capture_id }, async (span) => {
    const base = {
      team_id: job.team_id,
      capture_id: job.capture_id,
      who: job.who,
      type: job.type,
      source_ref: job.source_ref,
      side: job.side,
    };
    let docs: RawDoc[];
    if (transcript) {
      const startMs = Date.parse(job.at);
      docs = chunkSegments(transcript.segments).map((c, seq) =>
        RawDocSchema.parse({
          ...base,
          id: `${job.capture_id}:${seq}`,
          seq,
          text: c.text,
          at: new Date(startMs + c.start_s * 1000).toISOString(),
          duration_s: c.end_s - c.start_s,
        }),
      );
    } else {
      if (job.text === undefined) throw new Error("job has neither text nor audio");
      docs = chunkText(job.text).map((text, seq) =>
        RawDocSchema.parse({ ...base, id: `${job.capture_id}:${seq}`, seq, text, at: job.at }),
      );
    }
    span.setAttribute("chunks", docs.length);
    return docs;
  });
}

function index(job: IngestJob, docs: RawDoc[], deps: PipelineDeps): Promise<void> {
  return withSpan("ingest.index", { capture_id: job.capture_id, docs: docs.length }, async (span) => {
    if (deps.chaos === true) {
      span.setAttribute("chaos", true);
      await (deps.sleep ?? realSleep)(CHAOS_DELAY_MS);
      if ((deps.random ?? Math.random)() < CHAOS_FAILURE_RATE) {
        throw new Error("chaos: injected index failure");
      }
    }
    // A silent recording is a success with nothing to index.
    if (docs.length > 0) await deps.store.indexRaw(docs);
  });
}

async function step<T>(name: PipelineStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new PipelineError(name, err);
  }
}

/** Turns one capture into raw docs. Resolves once they are searchable. Never updates or deletes raw docs. */
export function runPipeline(
  job: IngestJob,
  deps: PipelineDeps,
  onState: (state: "transcribing" | "indexing") => void,
): Promise<RawDoc[]> {
  const attrs = { capture_id: job.capture_id, team_id: job.team_id, type: job.type, who: job.who };
  return withSpan("ingest.pipeline", attrs, async () => {
    let transcript: Transcript | undefined;
    if (job.audio) {
      onState("transcribing");
      transcript = await step("transcribe", () => transcribe(job, deps));
    }
    const docs = await step("chunk", () => chunk(job, transcript));
    onState("indexing");
    await step("index", () => index(job, docs, deps));
    return docs;
  });
}
