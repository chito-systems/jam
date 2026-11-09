import type { CaptureStatus, Dispatcher, FeedEvent, IngestJob } from "@hh/shared";
import { type PipelineDeps, PipelineError, runPipeline } from "./pipeline";

const MAX_STATUSES = 500;
const MAX_CONCURRENT = 2;

type Listener = (event: FeedEvent) => void;

/** Runs the pipeline in this process: at most 2 captures at a time, the rest queued in order. */
export function createInlineDispatcher(deps: PipelineDeps): Dispatcher {
  const statuses = new Map<string, CaptureStatus>();
  const listeners = new Map<string, Set<Listener>>();
  const queue: IngestJob[] = [];
  let running = 0;

  const emit = (team_id: string, event: FeedEvent) => {
    for (const listener of listeners.get(team_id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        console.error("feed listener threw", { team_id, event: event.event, err });
      }
    }
  };

  const save = (status: CaptureStatus) => {
    statuses.delete(status.capture_id); // re-insert so the map stays in recency order
    statuses.set(status.capture_id, status);
    while (statuses.size > MAX_STATUSES) {
      const oldest = statuses.keys().next().value;
      if (oldest === undefined) break;
      statuses.delete(oldest);
    }
    emit(status.team_id, { event: "capture", data: status });
  };

  const update = (capture_id: string, patch: Partial<CaptureStatus>) => {
    const current = statuses.get(capture_id);
    if (current) save({ ...current, ...patch });
  };

  const run = async (job: IngestJob) => {
    try {
      const docs = await runPipeline(job, deps, (state) => update(job.capture_id, { state }));
      const searchable = new Date();
      for (const doc of docs) emit(job.team_id, { event: "raw", data: doc });
      update(job.capture_id, {
        state: "indexed",
        raw_ids: docs.map((d) => d.id),
        searchable_at: searchable.toISOString(),
        ms_to_searchable: searchable.getTime() - Date.parse(job.received_at),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const step = err instanceof PipelineError ? err.step : "unknown";
      console.error("ingest failed", {
        capture_id: job.capture_id,
        team_id: job.team_id,
        step,
        error: message,
      });
      update(job.capture_id, { state: "failed", error: message });
    }
  };

  const pump = () => {
    while (running < MAX_CONCURRENT && queue.length > 0) {
      const job = queue.shift() as IngestJob; // length checked above
      running++;
      void run(job).finally(() => {
        running--;
        pump();
      });
    }
  };

  return {
    async dispatch(job) {
      const status: CaptureStatus = {
        capture_id: job.capture_id,
        team_id: job.team_id,
        who: job.who,
        type: job.type,
        state: "queued",
        received_at: job.received_at,
        raw_ids: [],
      };
      save(status);
      queue.push(job);
      pump();
      return status;
    },

    async status(capture_id) {
      return statuses.get(capture_id);
    },

    async captures(team_id) {
      return [...statuses.values()].filter((s) => s.team_id === team_id).reverse();
    },

    publish(team_id, event) {
      emit(team_id, event);
    },

    subscribe(team_id, listener) {
      let set = listeners.get(team_id);
      if (!set) {
        set = new Set();
        listeners.set(team_id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(team_id);
      };
    },
  };
}
