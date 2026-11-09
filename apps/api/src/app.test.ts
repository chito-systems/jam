import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureStatus,
  type ContextStore,
  type Dispatcher,
  type IngestJob,
  MemoryStore,
  type SearchResponse,
} from "@hh/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

/** Indexes text jobs as one raw doc immediately; records every job. */
function fakeDispatcher(store: ContextStore) {
  const jobs: IngestJob[] = [];
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
    publish() {},
    subscribe() {
      return () => {};
    },
  };
  return { dispatcher, jobs };
}

function setup(store: ContextStore = new MemoryStore()) {
  const { dispatcher, jobs } = fakeDispatcher(store);
  return { app: createApp({ store, dispatcher }), jobs };
}

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
    expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
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
});
