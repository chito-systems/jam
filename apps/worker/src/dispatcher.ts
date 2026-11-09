import type { CaptureStatus, Dispatcher, FeedEvent, IngestJob, RawDoc } from "@hh/shared";
import type { Librarian } from "./librarian";
import { type PipelineDeps, PipelineError, runPipeline } from "./pipeline";

export interface DispatcherDeps extends PipelineDeps {
  /** Absent = no structured items. Runs after a capture is indexed, never on the SLO path. */
  librarian?: Librarian;
}

const MAX_STATUSES = 500;
const MAX_CONCURRENT = 2;

type Listener = (event: FeedEvent) => void;

/**
 * Runs the pipeline in this process: at most 2 captures at a time, the rest queued in order.
 * After a capture is indexed, the librarian (if any) runs one call at a time in the background.
 */
export function createInlineDispatcher(deps: DispatcherDeps): Dispatcher {
  const statuses = new Map<string, CaptureStatus>();
  const listeners = new Map<string, Set<Listener>>();
  const queue: IngestJob[] = [];
  let running = 0;
  let librarianChain: Promise<void> = Promise.resolve();

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

  const librarian = async (job: IngestJob, docs: RawDoc[], lib: Librarian) => {
    try {
      const recent = await deps.store.items({ team_id: job.team_id, limit: 20 });
      const items = await lib.extract({ team_id: job.team_id, docs, recent });
      if (items.length === 0) return;
      await deps.store.indexItems(items);
      for (const item of items) emit(job.team_id, { event: "item", data: item });
    } catch (err) {
      console.error("librarian failed", {
        capture_id: job.capture_id,
        team_id: job.team_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** Fire and forget, serialized: a burst of captures queues instead of fanning out. */
  const enqueueLibrarian = (job: IngestJob, docs: RawDoc[]) => {
    const lib = deps.librarian;
    // The decision log is for what people said. Delegator bookkeeping, PR text and
    // AI review comments stay searchable as raw context but are not mined for decisions.
    const machineMade = job.source_ref?.startsWith("task:") || job.type === "pr" || job.type === "review";
    if (!lib || docs.length === 0 || machineMade) return;
    librarianChain = librarianChain.then(() => librarian(job, docs, lib));
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
      enqueueLibrarian(job, docs);
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
