import { type Context, context, metrics } from "@opentelemetry/api";
import {
  assignWork,
  type CaptureStatus,
  type Dispatcher,
  type FeedEvent,
  type IngestJob,
  type ItemDoc,
  normalizePath,
  parseRoster,
  type RawDoc,
  type RosterEntry,
  type TaskDoc,
  TaskDocSchema,
} from "@hh/shared";
import type { Librarian } from "./librarian";
import type { Planner } from "./planner";
import { type PipelineDeps, PipelineError, runPipeline } from "./pipeline";

export interface DispatcherDeps extends PipelineDeps {
  /** Absent = no structured items. Runs after a capture is indexed, never on the SLO path. */
  librarian?: Librarian;
  /** Absent = no work orders. Drafts one per new confident todo, after the librarian stored it. */
  planner?: Planner;
  /** Who is on which side, for assignment. Defaults to parseRoster(undefined). */
  roster?: RosterEntry[];
}

const MAX_STATUSES = 500;
const MAX_CONCURRENT = 2;
/** Existing items the librarian sees, so it can supersede them and not repeat them. */
export const RECENT_ITEMS = 50;
/** A todo needs at least this much librarian confidence before jam drafts a work order for it. */
export const PLAN_MIN_CONFIDENCE = 0.7;
/** Work orders drafted per capture, at most: a long ramble shouldn't flood the board. */
export const MAX_PLANS_PER_CAPTURE = 2;

type Listener = (event: FeedEvent) => void;

/** Instruments via the OTel API: no-ops without the SDK. Created per dispatcher, after otel.ts registered the provider. */
function captureMetrics() {
  const meter = metrics.getMeter("hack-harness");
  return {
    // The SLO: "searchable within 10 s, p95". Dashboards and alerts key on this name and unit.
    timeToSearchable: meter.createHistogram("jam.capture.time_to_searchable", {
      unit: "ms",
      description: "Time from upload received to raw docs searchable",
    }),
    captures: meter.createCounter("jam.capture.total", { description: "Captures that reached a terminal state" }),
    items: meter.createCounter("jam.librarian.items", { description: "Items the librarian extracted" }),
    workOrders: meter.createCounter("jam.planner.work_orders", { description: "Work orders jam drafted" }),
  };
}

/**
 * Runs the pipeline in this process: at most 2 captures at a time, the rest queued in order.
 * After a capture is indexed, the librarian (if any) runs one call at a time in the background.
 */
export function createInlineDispatcher(deps: DispatcherDeps): Dispatcher {
  const statuses = new Map<string, CaptureStatus>();
  const listeners = new Map<string, Set<Listener>>();
  // Each job keeps the context it was dispatched in, so its pipeline joins the request's trace.
  const queue: { job: IngestJob; ctx: Context }[] = [];
  const m = captureMetrics();
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

  const roster = deps.roster ?? parseRoster(undefined);

  /** Drafts and stores one proposed work order for a todo, unless it already has one. */
  const plan = async (todo: ItemDoc, planner: Planner) => {
    const existing = await deps.store.tasks({ team_id: todo.team_id, limit: 200 });
    if (existing.some((t) => t.item_id === todo.id)) return;
    const quotes = await deps.store.rawByIds(todo.team_id, todo.raw_ids);
    quotes.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    const decisions = (await deps.store.items({ team_id: todo.team_id, kind: "decision", limit: 15 })).filter(
      (d) => d.verdict !== "rejected",
    );
    const draft = await planner.draft({ todo, quotes, decisions });
    const paths = [...new Set(draft.paths.map(normalizePath).filter(Boolean))];
    const who = assignWork({ text: todo.text, speaker: todo.who, paths, roster });
    const at = new Date().toISOString();
    const candidate: TaskDoc = {
      team_id: todo.team_id,
      id: crypto.randomUUID(),
      title: (draft.title.trim() || todo.text.trim().slice(0, 80)).slice(0, 200),
      side: who.side,
      owner: "jam",
      paths,
      status: "proposed",
      spec: draft.spec,
      item_id: todo.id,
      raw_ids: todo.raw_ids,
      proposed_by: "jam",
      ...(who.suggested_owner ? { suggested_owner: who.suggested_owner } : {}),
      reason: who.reason,
      created_at: at,
      updated_at: at,
    };
    // Never store a task the store can't read back: one bad doc would break tasks() for the whole team.
    const valid = TaskDocSchema.safeParse(candidate);
    if (!valid.success) {
      console.error("planner drafted an invalid task; skipped", {
        team_id: todo.team_id,
        item_id: todo.id,
        error: valid.error.message.slice(0, 300),
      });
      return;
    }
    const task = valid.data;
    await deps.store.upsertTask(task);
    m.workOrders.add(1, { side: task.side });
    emit(todo.team_id, { event: "task", data: task });
  };

  /** jam's pass over what the librarian just stored. A failure is logged once and touches nothing else. */
  const planWorkOrders = async (job: IngestJob, fresh: ItemDoc[], planner: Planner) => {
    const todos = fresh
      .filter((i) => i.kind === "todo" && i.status === "open" && (i.confidence ?? 0) >= PLAN_MIN_CONFIDENCE)
      .slice(0, MAX_PLANS_PER_CAPTURE);
    for (const todo of todos) {
      try {
        await plan(todo, planner);
      } catch (err) {
        console.error("planner failed", {
          capture_id: job.capture_id,
          team_id: job.team_id,
          item_id: todo.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const librarian = async (job: IngestJob, docs: RawDoc[], lib: Librarian) => {
    let fresh: ItemDoc[] = [];
    try {
      const recent = await deps.store.items({ team_id: job.team_id, limit: RECENT_ITEMS });
      const known = new Set(recent.map((i) => i.id));
      const extracted = await lib.extract({ team_id: job.team_id, docs, recent });
      if (extracted.length === 0) return;
      // A human may have graded an item while the model was thinking: re-read before writing back.
      const items = await Promise.all(
        extracted.map(async (item) => {
          if (!known.has(item.id)) return item;
          const fresh = await deps.store.itemById(job.team_id, item.id);
          if (!fresh) return item;
          const { verdict: _v, verified_by: _b, verified_at: _a, ...rest } = item;
          const { verdict, verified_by, verified_at } = fresh;
          return { ...rest, ...(verdict ? { verdict, verified_by, verified_at } : {}) };
        }),
      );
      await deps.store.indexItems(items);
      for (const item of items) m.items.add(1, { kind: item.kind });
      for (const item of items) emit(job.team_id, { event: "item", data: item });
      fresh = items.filter((i) => !known.has(i.id)); // new items, not status updates of existing ones
    } catch (err) {
      console.error("librarian failed", {
        capture_id: job.capture_id,
        team_id: job.team_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (deps.planner && fresh.length > 0) await planWorkOrders(job, fresh, deps.planner);
  };

  /** Fire and forget, serialized: a burst of captures queues instead of fanning out. */
  const enqueueLibrarian = (job: IngestJob, docs: RawDoc[]) => {
    const lib = deps.librarian;
    // The decision log is for what people said. Delegator bookkeeping, PR text and
    // AI review comments and the chaos switch's own posts stay searchable as raw context but are not mined.
    const machineMade =
      job.source_ref?.startsWith("task:") || job.source_ref === "chaos" || job.type === "pr" || job.type === "review";
    if (!lib || docs.length === 0 || machineMade) return;
    const ctx = context.active();
    librarianChain = librarianChain.then(() => context.with(ctx, () => librarian(job, docs, lib)));
  };

  const run = async (job: IngestJob) => {
    try {
      const docs = await runPipeline(job, deps, (state) => update(job.capture_id, { state }));
      const searchable = new Date();
      const ms_to_searchable = searchable.getTime() - Date.parse(job.received_at);
      m.timeToSearchable.record(ms_to_searchable, { type: job.type, team_id: job.team_id });
      m.captures.add(1, { state: "indexed", type: job.type });
      for (const doc of docs) emit(job.team_id, { event: "raw", data: doc });
      update(job.capture_id, {
        state: "indexed",
        raw_ids: docs.map((d) => d.id),
        searchable_at: searchable.toISOString(),
        ms_to_searchable,
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
      m.captures.add(1, { state: "failed", type: job.type });
      update(job.capture_id, { state: "failed", error: message });
    }
  };

  const pump = () => {
    while (running < MAX_CONCURRENT && queue.length > 0) {
      const { job, ctx } = queue.shift() as { job: IngestJob; ctx: Context }; // length checked above
      running++;
      void context.with(ctx, () => run(job)).finally(() => {
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
      queue.push({ job, ctx: context.active() });
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
