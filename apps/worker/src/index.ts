// STUB — replaced by the stream A worker PR. Signature is fixed; apps/api imports it.
import type { ContextStore, Dispatcher, Transcriber } from "@hh/shared";

export interface PipelineDeps {
  store: ContextStore;
  /** Absent = text-only (voice captures fail with a clear error). */
  transcriber?: Transcriber;
  /** CHAOS_MODE: adds latency and failures to the index step. Defaults off. */
  chaos?: boolean;
}

/** Runs the pipeline in this process. */
export function createInlineDispatcher(_deps: PipelineDeps): Dispatcher {
  throw new Error("worker pipeline not implemented yet");
}

export { createTranscriberFromEnv } from "./transcribers";
