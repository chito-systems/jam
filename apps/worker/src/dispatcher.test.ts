import {
  type CaptureStatus,
  type Dispatcher,
  type FeedEvent,
  type IngestJob,
  type ItemDoc,
  MemoryStore,
  TaskDocSchema,
  type Transcriber,
  type Transcript,
} from "@hh/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInlineDispatcher } from "./dispatcher";
import type { Librarian } from "./librarian";
import type { Planner, PlannerInput } from "./planner";
import { type PipelineDeps, runPipeline } from "./pipeline";

const AT = "2026-11-09T19:00:00.000Z";

const job = (over: Partial<IngestJob> = {}): IngestJob => ({
  capture_id: "c1",
  team_id: "t1",
  who: "cam",
  type: "text",
  at: AT,
  received_at: AT,
  text: "we decided to use the merge queue",
  ...over,
});

const voiceJob = (over: Partial<IngestJob> = {}) =>
  job({ type: "voice", text: undefined, audio: { data: new Uint8Array([1]), mime: "audio/webm" }, ...over });

const fakeTranscriber = (transcript: Transcript): Transcriber => ({
  name: "fake",
  transcribe: async () => transcript,
});

/** Resolves when the capture reaches a terminal state. Call before dispatch. */
function terminal(d: Dispatcher, team_id: string, capture_id: string) {
  const events: FeedEvent[] = [];
  const done = new Promise<CaptureStatus>((resolve) => {
    const off = d.subscribe(team_id, (e) => {
      events.push(e);
      if (e.event === "capture" && e.data.capture_id === capture_id && (e.data.state === "indexed" || e.data.state === "failed")) {
        off();
        resolve(e.data);
      }
    });
  });
  return { events, done };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("runPipeline", () => {
  it("chunks a voice job into docs with offset times and ids", async () => {
    const store = new MemoryStore();
    const transcriber = fakeTranscriber({
      duration_s: 70,
      segments: [
        { start_s: 0, end_s: 20, text: "first" },
        { start_s: 20, end_s: 40, text: "second" },
        { start_s: 40, end_s: 65.5, text: "third" },
      ],
    });
    const states: string[] = [];
    const docs = await runPipeline(voiceJob({ source_ref: "rec.webm" }), { store, transcriber }, (s) => states.push(s));
    expect(states).toEqual(["transcribing", "indexing"]);
    expect(docs.map((d) => [d.id, d.seq, d.at, d.duration_s, d.text])).toEqual([
      ["c1:0", 0, AT, 20, "first"],
      ["c1:1", 1, "2026-11-09T19:00:20.000Z", 20, "second"],
      ["c1:2", 2, "2026-11-09T19:00:40.000Z", 25.5, "third"],
    ]);
    expect(docs[0]?.source_ref).toBe("rec.webm");
    expect(await store.recent({ team_id: "t1", limit: 20 })).toHaveLength(3);
  });

  it("indexes a text job with every chunk at job.at", async () => {
    const store = new MemoryStore();
    const states: string[] = [];
    const text = `${"a".repeat(1000)}\n\n${"b".repeat(1000)}`;
    const docs = await runPipeline(job({ text }), { store }, (s) => states.push(s));
    expect(states).toEqual(["indexing"]);
    expect(docs.map((d) => [d.id, d.at])).toEqual([
      ["c1:0", AT],
      ["c1:1", AT],
    ]);
  });

  it("treats a silent recording as success with zero docs", async () => {
    const deps = { store: new MemoryStore(), transcriber: fakeTranscriber({ duration_s: 5, segments: [] }) };
    expect(await runPipeline(voiceJob(), deps, () => {})).toEqual([]);
  });
});

describe("inline dispatcher", () => {
  it("returns queued immediately, then walks the states and emits raw events", async () => {
    const d = createInlineDispatcher({
      store: new MemoryStore(),
      transcriber: fakeTranscriber({ duration_s: 3, segments: [{ start_s: 0, end_s: 3, text: "hi" }] }),
    });
    const { events, done } = terminal(d, "t1", "c1");
    const queued = await d.dispatch(voiceJob());
    expect(queued.state).toBe("queued");
    const final = await done;

    expect(events.filter((e) => e.event === "capture").map((e) => e.data.state)).toEqual([
      "queued",
      "transcribing",
      "indexing",
      "indexed",
    ]);
    expect(events.filter((e) => e.event === "raw").map((e) => e.data.id)).toEqual(["c1:0"]);
    expect(final.raw_ids).toEqual(["c1:0"]);
    expect(final.searchable_at).toBeDefined();
    expect(final.ms_to_searchable).toBe(Date.parse(final.searchable_at ?? "") - Date.parse(AT));
    expect(await d.status("c1")).toEqual(final);
  });

  it("emits queued on the feed and fails a duplicate capture id on immutability", async () => {
    const d = createInlineDispatcher({ store: new MemoryStore() });
    const first = terminal(d, "t1", "c1");
    await d.dispatch(job());
    expect(first.events[0]).toMatchObject({ event: "capture", data: { state: "queued" } });
    expect((await first.done).state).toBe("indexed");

    const second = terminal(d, "t1", "c1");
    await d.dispatch(job());
    const final = await second.done;
    expect(final.state).toBe("failed");
    expect(final.error).toMatch(/immutable/);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({ capture_id: "c1", team_id: "t1", step: "index" });
  });

  it("fails voice with no transcriber with a clear message", async () => {
    const d = createInlineDispatcher({ store: new MemoryStore() });
    const { done } = terminal(d, "t1", "c1");
    await d.dispatch(voiceJob());
    const final = await done;
    expect(final.state).toBe("failed");
    expect(final.error).toBe("no transcriber configured (set OPENAI_API_KEY)");
  });

  it("keeps chaos off by default", async () => {
    const sleep = vi.fn(async () => {});
    const random = vi.fn(() => 0);
    const d = createInlineDispatcher({ store: new MemoryStore(), sleep, random });
    const { done } = terminal(d, "t1", "c1");
    await d.dispatch(job());
    expect((await done).state).toBe("indexed");
    expect(sleep).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it("injects latency and failure when chaos is on", async () => {
    const sleep = vi.fn(async () => {});
    const deps: PipelineDeps = { store: new MemoryStore(), chaos: true, sleep, random: () => 0.1 };
    const d = createInlineDispatcher(deps);
    const { done } = terminal(d, "t1", "c1");
    await d.dispatch(job());
    const final = await done;
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(final.state).toBe("failed");
    expect(final.error).toBe("chaos: injected index failure");
  });

  it("passes through chaos when the dice say so", async () => {
    const d = createInlineDispatcher({ store: new MemoryStore(), chaos: true, sleep: async () => {}, random: () => 0.5 });
    const { done } = terminal(d, "t1", "c1");
    await d.dispatch(job());
    expect((await done).state).toBe("indexed");
  });

  it("isolates subscribers by team and survives a throwing listener", async () => {
    const d = createInlineDispatcher({ store: new MemoryStore() });
    const other: FeedEvent[] = [];
    d.subscribe("t2", (e) => other.push(e));
    d.subscribe("t1", () => {
      throw new Error("bad listener");
    });
    const { done } = terminal(d, "t1", "c1");
    await d.dispatch(job());
    expect((await done).state).toBe("indexed");
    expect(other).toEqual([]);
  });

  it("runs at most two captures at once and keeps queue order", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const transcriber: Transcriber = {
      name: "slow",
      transcribe: () =>
        new Promise<Transcript>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            resolve({ duration_s: 1, segments: [{ start_s: 0, end_s: 1, text: "x" }] });
          });
        }),
    };
    const d = createInlineDispatcher({ store: new MemoryStore(), transcriber });
    const ids = ["a", "b", "c"];
    const dones = ids.map((id) => terminal(d, "t1", id).done);
    for (const id of ids) await d.dispatch(voiceJob({ capture_id: id }));
    expect(releases).toHaveLength(2);
    expect((await d.status("c"))?.state).toBe("queued");
    releases.shift()?.(); // finish a
    expect((await dones[0])?.state).toBe("indexed");
    await vi.waitFor(() => expect(releases).toHaveLength(2)); // c started in a's slot
    releases.shift()?.();
    releases.shift()?.();
    const finals = await Promise.all(dones);
    expect(finals.map((f) => f.state)).toEqual(["indexed", "indexed", "indexed"]);
    expect(peak).toBe(2);
  });
});

describe("jam work orders", () => {
  const todo = (over: Partial<ItemDoc> = {}): ItemDoc => ({
    team_id: "t1",
    id: "todo-1",
    kind: "todo",
    text: "Jake adds confirm and reject buttons to the decisions list.",
    who: "cam",
    at: AT,
    tags: [],
    raw_ids: ["c1:0"],
    status: "open",
    confidence: 0.9,
    ...over,
  });
  const defaultDraft: Planner["draft"] = async () => ({ title: "Add buttons", paths: ["./apps/web/src/"], spec: "## Goal\nx" });

  function setup(items: ItemDoc[], draft: Planner["draft"] = defaultDraft) {
    const store = new MemoryStore();
    const events: FeedEvent[] = [];
    const drafts: PlannerInput[] = [];
    const librarian: Librarian = { name: "fake", extract: async () => items };
    const planner: Planner = {
      name: "fake",
      draft: async (input) => {
        drafts.push(input);
        return draft(input);
      },
    };
    const d = createInlineDispatcher({ store, librarian, planner });
    d.subscribe("t1", (e) => events.push(e));
    return { store, d, events, drafts };
  }
  const itemEvents = (events: FeedEvent[], n: number) =>
    vi.waitFor(() => expect(events.filter((e) => e.event === "item")).toHaveLength(n));
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("drafts exactly one proposed task for a confident new todo and publishes it", async () => {
    const { store, d, events, drafts } = setup([todo(), todo({ id: "d1", kind: "decision", text: "Use Elastic." })]);
    await store.indexItems([todo({ id: "d0", kind: "decision", verdict: "rejected", text: "Use Postgres." })]);
    await d.dispatch(job({ text: "Jake, can you add confirm and reject buttons" }));
    await vi.waitFor(() => expect(events.some((e) => e.event === "task")).toBe(true));
    const tasks = await store.tasks({ team_id: "t1", limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: "proposed",
      owner: "jam",
      proposed_by: "jam",
      title: "Add buttons",
      paths: ["apps/web/src"],
      spec: "## Goal\nx",
      item_id: "todo-1",
      raw_ids: ["c1:0"],
      side: "frontend",
      suggested_owner: "jake",
      reason: "Jake was named in the request.",
    });
    expect(TaskDocSchema.parse(tasks[0])).toEqual(tasks[0]);
    expect(drafts[0]?.quotes.map((q) => q.id)).toEqual(["c1:0"]);
    expect(drafts[0]?.decisions.map((x) => x.id)).toEqual(["d1"]); // the rejected one is dropped
  });

  it("drafts nothing for a low-confidence todo, a decision, or a todo that already has a task", async () => {
    const { store, d, events, drafts } = setup([
      todo({ id: "low", confidence: 0.6 }),
      todo({ id: "dec", kind: "decision" }),
      todo({ id: "has" }),
    ]);
    await store.upsertTask({
      team_id: "t1",
      id: "x",
      title: "t",
      side: "backend",
      owner: "jam",
      paths: [],
      status: "proposed",
      item_id: "has",
      created_at: AT,
      updated_at: AT,
    });
    await d.dispatch(job());
    await itemEvents(events, 3);
    await tick();
    expect(drafts).toEqual([]);
    expect(events.some((e) => e.event === "task")).toBe(false);
  });

  it("skips status updates of existing todos, and chaos captures entirely", async () => {
    const { store, d, events, drafts } = setup([todo({ id: "old", status: "done" })]);
    await store.indexItems([todo({ id: "old" })]);
    await d.dispatch(job());
    await itemEvents(events, 1);
    await d.dispatch(job({ capture_id: "c2", source_ref: "chaos" }));
    await vi.waitFor(async () => expect((await d.status("c2"))?.state).toBe("indexed"));
    await tick();
    expect(drafts).toEqual([]);
    expect(events.filter((e) => e.event === "item")).toHaveLength(1);
  });

  it("a planner failure leaves the capture and the items intact, logged once", async () => {
    const { store, d, events } = setup([todo()], async () => {
      throw new Error("model down");
    });
    await d.dispatch(job());
    await itemEvents(events, 1);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    expect(errorSpy.mock.calls[0]?.[0]).toBe("planner failed");
    expect((await d.status("c1"))?.state).toBe("indexed");
    expect(await store.items({ team_id: "t1", limit: 10 })).toHaveLength(1);
    expect(await store.tasks({ team_id: "t1", limit: 10 })).toEqual([]);
  });
});
