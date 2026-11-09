import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureStatus,
  type ContextStore,
  type Dispatcher,
  type FeedEvent,
  type IngestJob,
  MemoryStore,
  type SearchResponse,
  type StatsResponse,
  type TaskConflict,
  type TaskDoc,
} from "@hh/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

/** Indexes text jobs as one raw doc immediately; records every job. */
function fakeDispatcher(store: ContextStore) {
  const jobs: IngestJob[] = [];
  const events: FeedEvent[] = [];
  const statuses = new Map<string, CaptureStatus>();
  const dispatcher: Dispatcher = {
    async dispatch(job) {
      jobs.push(job);
      if (job.text) {
        await store.indexRaw([
          { ...job, id: `${job.capture_id}:0`, seq: 0, text: job.text },
        ]);
      }
      const status: CaptureStatus = {
        capture_id: job.capture_id,
        team_id: job.team_id,
        who: job.who,
        type: job.type,
        state: job.text ? "indexed" : "queued",
        received_at: job.received_at,
        raw_ids: job.text ? [`${job.capture_id}:0`] : [],
      };
      statuses.set(job.capture_id, status);
      return status;
    },
    async status(id) {
      return statuses.get(id);
    },
    async captures() {
      return [...statuses.values()];
    },
    publish(_team_id, event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
  };
  return { dispatcher, jobs, events, statuses };
}

function setup(store: ContextStore = new MemoryStore()) {
  const fake = fakeDispatcher(store);
  return { app: createApp({ store, dispatcher: fake.dispatcher }), ...fake };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const claim = (paths: string[], extra: Record<string, unknown> = {}) =>
  post({ team_id: "t1", who: "agent:opus-1", side: "backend", title: "tasks api", paths, ...extra });

const upload = (fields: Record<string, string>, file: File) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", file);
  return { method: "POST", body: form };
};

describe("api", () => {
  it("ingests JSON text and makes it searchable", async () => {
    const { app } = setup();
    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_id: "t1", who: "cam", text: "we picked the merge queue" }),
    });
    expect(res.status).toBe(202);
    const { capture_id, state } = (await res.json()) as { capture_id: string; state: string };
    expect(state).toBe("indexed");

    const status = await app.request(`/api/captures/${capture_id}`);
    expect(status.status).toBe(200);

    const search = await app.request("/api/search?team_id=t1&q=merge");
    const body = (await search.json()) as SearchResponse;
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]?.doc.text).toBe("we picked the merge queue");
  });

  it("rejects a bad JSON body with 400 and zod issues", async () => {
    const { app } = setup();
    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_id: "t1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: unknown[] };
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail.length).toBeGreaterThan(0);
  });

  it("rejects bad query params with 400", async () => {
    const { app } = setup();
    expect((await app.request("/api/search?team_id=t1")).status).toBe(400);
    expect((await app.request("/api/recent?team_id=t1")).status).toBe(200);
  });

  it("puts an audio upload in job.audio, not job.text", async () => {
    const { app, jobs } = setup();
    const file = new File([new Uint8Array([1, 2, 3])], "clip.webm", { type: "audio/webm" });
    const res = await app.request("/api/ingest", upload({ team_id: "t1", who: "jake" }, file));
    expect(res.status).toBe(202);
    expect(jobs[0]?.text).toBeUndefined();
    expect(jobs[0]?.audio?.mime).toBe("audio/webm");
    expect(jobs[0]?.audio?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("treats a .md upload as text with source_ref = filename", async () => {
    const { app, jobs } = setup();
    const file = new File(["# notes\nship it"], "notes.md", { type: "text/markdown" });
    const res = await app.request("/api/ingest", upload({ team_id: "t1", who: "cam", type: "file" }, file));
    expect(res.status).toBe(202);
    expect(jobs[0]?.audio).toBeUndefined();
    expect(jobs[0]?.text).toBe("# notes\nship it");
    expect(jobs[0]?.source_ref).toBe("notes.md");
  });

  it("rejects uploads over 25 MB with 413", async () => {
    const { app, jobs } = setup();
    const file = new File([new Uint8Array(26 * 1024 * 1024)], "big.webm", { type: "audio/webm" });
    const res = await app.request("/api/ingest", upload({ team_id: "t1", who: "cam" }, file));
    expect(res.status).toBe(413);
    expect(jobs).toHaveLength(0);
  });

  it("404s an unknown capture", async () => {
    const { app } = setup();
    const res = await app.request("/api/captures/unknown");
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  it("reports readiness from store.ping", async () => {
    expect((await setup().app.request("/readyz")).status).toBe(200);
    const down = new MemoryStore();
    down.ping = async () => false;
    expect((await setup(down).app.request("/readyz")).status).toBe(503);
  });

  it("serves the capture page and healthz", async () => {
    const { app } = setup();
    const page = await app.request("/c");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<");
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true, version: "dev" });
  });

  it("serves webDist with an SPA fallback that skips API paths", async () => {
    const webDist = mkdtempSync(join(tmpdir(), "hh-web-"));
    writeFileSync(join(webDist, "index.html"), "<div id=app></div>");
    const store = new MemoryStore();
    const app = createApp({ store, dispatcher: fakeDispatcher(store).dispatcher, webDist });
    expect(await (await app.request("/brain/deep/link")).text()).toBe("<div id=app></div>");
    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not found" });
  });

  it("carries side through JSON and multipart ingest", async () => {
    const { app, jobs } = setup();
    await app.request("/api/ingest", post({ team_id: "t1", who: "cam", text: "hi", side: "backend" }));
    const file = new File([new Uint8Array([1])], "a.webm", { type: "audio/webm" });
    await app.request("/api/ingest", upload({ team_id: "t1", who: "jake", side: "frontend" }, file));
    expect(jobs.map((j) => j.side)).toEqual(["backend", "frontend"]);
  });

  it("reads a .md upload without a type as text, typed file", async () => {
    const { app, jobs } = setup();
    const file = new File(["ship it"], "notes.md", { type: "text/markdown" });
    expect((await app.request("/api/ingest", upload({ team_id: "t1", who: "cam" }, file))).status).toBe(202);
    expect(jobs[0]?.audio).toBeUndefined();
    expect(jobs[0]?.text).toBe("ship it");
    expect(jobs[0]?.type).toBe("file");
  });

  it("claims a task: 201, feed event, brain note", async () => {
    const { app, jobs, events } = setup();
    const res = await app.request("/api/tasks", claim(["apps/api/src/"]));
    expect(res.status).toBe(201);
    const task = (await res.json()) as TaskDoc;
    expect(task).toMatchObject({ status: "claimed", owner: "agent:opus-1", paths: ["apps/api/src"] });
    expect(events).toEqual([{ event: "task", data: task }]);
    expect(jobs[0]).toMatchObject({ type: "text", who: "agent:opus-1", side: "backend", source_ref: `task:${task.id}` });
    expect(jobs[0]?.text).toContain("[task claimed] tasks api");
  });

  it("still grants a claim when the brain write fails", async () => {
    const { app, dispatcher } = setup();
    dispatcher.dispatch = async () => {
      throw new Error("elastic down");
    };
    expect((await app.request("/api/tasks", claim(["apps/api/"]))).status).toBe(201);
  });

  it("refuses overlap and wrong side with 409", async () => {
    const { app } = setup();
    await app.request("/api/tasks", claim(["apps/api/"]));
    const overlap = await app.request("/api/tasks", claim(["apps/api/src/app.ts"]));
    expect(overlap.status).toBe(409);
    const body = (await overlap.json()) as TaskConflict;
    expect(body.reason).toBe("overlap");
    expect(body.conflicts).toHaveLength(1);
    const wrong = await app.request("/api/tasks", claim(["apps/web/src/"]));
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as TaskConflict).reason).toBe("wrong_side");
  });

  it("close frees the paths; unknown id 404s", async () => {
    const { app, jobs, events } = setup();
    const task = (await (await app.request("/api/tasks", claim(["apps/api/"]))).json()) as TaskDoc;
    const closed = await app.request(`/api/tasks/${task.id}/close`, post({ team_id: "t1", who: "cam", pr: "42" }));
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as TaskDoc).status).toBe("done");
    expect(events.at(-1)?.event).toBe("task");
    expect(jobs.at(-1)?.text).toContain("[task done]");
    expect(jobs.at(-1)?.text).toContain("PR 42");
    expect((await app.request("/api/tasks", claim(["apps/api/src/"]))).status).toBe(201);
    const missing = await app.request("/api/tasks/nope/close", post({ team_id: "t1", who: "cam" }));
    expect(missing.status).toBe(404);
  });

  it("lists tasks with filters", async () => {
    const { app } = setup();
    const a = (await (await app.request("/api/tasks", claim(["apps/api/"]))).json()) as TaskDoc;
    await app.request("/api/tasks", claim(["apps/web/"], { side: "frontend", who: "jake" }));
    await app.request(`/api/tasks/${a.id}/close`, post({ team_id: "t1", who: "cam", status: "released" }));
    const list = async (q: string) =>
      ((await (await app.request(`/api/tasks?team_id=t1${q}`)).json()) as { tasks: TaskDoc[] }).tasks;
    expect(await list("")).toHaveLength(2);
    expect((await list("&status=claimed")).map((t) => t.owner)).toEqual(["jake"]);
    expect((await list("&side=backend")).map((t) => t.status)).toEqual(["released"]);
  });

  it("reports stats with nearest-rank p50/p95", async () => {
    const { app, statuses } = setup();
    await app.request("/api/ingest", post({ team_id: "t1", who: "cam", text: "hello", side: "backend" }));
    await app.request("/api/tasks", claim(["apps/api/"]));
    statuses.clear();
    const base: Omit<CaptureStatus, "capture_id" | "state"> = { team_id: "t1", who: "cam", type: "voice", received_at: "2026-11-09T12:00:00.000Z", raw_ids: [] };
    [100, 200, 300, 400, 5000].forEach((ms, i) => {
      statuses.set(`c${i}`, { ...base, capture_id: `c${i}`, state: "indexed", ms_to_searchable: ms });
    });
    statuses.set("bad", { ...base, capture_id: "bad", state: "failed" });
    // Repo activity from the GitHub poller is not a person waiting: it must not move the SLO.
    statuses.set("gh", { ...base, capture_id: "gh", type: "pr", state: "indexed", ms_to_searchable: 60000 });
    const stats = (await (await app.request("/api/stats?team_id=t1")).json()) as StatsResponse;
    expect(stats.open_tasks).toBe(1);
    expect(stats.raw_total).toBe(2); // the capture + the task-claimed brain note
    expect(stats.by_side).toMatchObject({ backend: 2 });
    expect(stats.slo).toEqual({ target_ms: 10000, count: 5, p50_ms: 300, p95_ms: 5000, failed: 1 });
  });

  it("omits percentiles when there are no timed captures", async () => {
    const stats = (await (await setup().app.request("/api/stats?team_id=t1")).json()) as StatsResponse;
    expect(stats.slo).toEqual({ target_ms: 10000, count: 0, failed: 0 });
    expect((await setup().app.request("/api/stats")).status).toBe(400);
  });
});
