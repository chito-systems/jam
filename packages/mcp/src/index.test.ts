import { type CaptureStatus, type Dispatcher, type FeedEvent, type IngestJob, MemoryStore } from "@hh/shared";
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "./index";

/** Indexes text jobs straight into the store, like the inline dispatcher will. */
function fakeDispatcher(store: MemoryStore, published: FeedEvent[] = []): Dispatcher {
  return {
    async dispatch(job: IngestJob): Promise<CaptureStatus> {
      const id = `${job.capture_id}:0`;
      await store.indexRaw([
        { team_id: job.team_id, id, capture_id: job.capture_id, type: job.type, who: job.who, at: job.at, seq: 0, text: job.text ?? "", source_ref: job.source_ref, side: job.side },
      ]);
      return { capture_id: job.capture_id, team_id: job.team_id, who: job.who, type: job.type, state: "indexed", received_at: job.received_at, raw_ids: [id] };
    },
    async status() {
      return undefined;
    },
    async captures() {
      return [];
    },
    publish(_team_id, event) {
      published.push(event);
    },
    subscribe() {
      return () => {};
    },
  };
}

function setup() {
  const store = new MemoryStore();
  const published: FeedEvent[] = [];
  const deps = { store, dispatcher: fakeDispatcher(store, published) };
  let nextId = 1;
  const post = (method: string, params: unknown, query = "team_id=t1&who=opus-1") =>
    handleMcpRequest(
      new Request(`http://localhost/mcp?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      }),
      deps,
    );
  const call = async (name: string, args: Record<string, unknown>, query?: string) => {
    const res = await post("tools/call", { name, arguments: args }, query);
    expect(res.status).toBe(200);
    const body = await res.json();
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError };
  };
  return { store, post, call, published };
}

describe("handleMcpRequest", () => {
  it("answers initialize", async () => {
    const { post } = setup();
    const res = await post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("hack-harness-context");
  });

  it("lists the eight tools", async () => {
    const { post } = setup();
    const body = await (await post("tools/list", {})).json();
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "context_add",
      "context_decisions",
      "context_recent",
      "context_search",
      "item_verdict",
      "task_claim",
      "task_done",
      "task_list",
    ]);
  });

  it("context_add then context_search finds it, attributed to the agent", async () => {
    const { call } = setup();
    const added = await call("context_add", { text: "Chose Hono over Express for web Request support", kind: "decision" });
    expect(added.text).toMatch(/Recorded as capture [0-9a-f-]{36}/);
    const found = await call("context_search", { query: "Hono" });
    expect(found.text).toContain("agent:opus-1");
    expect(found.text).toContain("[decision] Chose Hono");
  });

  it("context_recent is scoped to the team in the url", async () => {
    const { call } = setup();
    await call("context_add", { text: "secret plan of team two" }, "team_id=t2");
    await call("context_add", { text: "team one update" });
    const recent = await call("context_recent", {});
    expect(recent.text).toContain("team one update");
    expect(recent.text).not.toContain("team two");
  });

  it("context_decisions says so explicitly when there are none", async () => {
    const { call } = setup();
    const res = await call("context_decisions", {});
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/No extracted decisions yet.*"decided"/);
  });

  it("context_decisions grades each line and omits rejected decisions", async () => {
    const { store, call } = setup();
    const base = { team_id: "t1", kind: "decision" as const, who: "cam", tags: [], raw_ids: [], status: "open" as const };
    await store.indexItems([
      { ...base, id: "d1", text: "Name is JAM.", at: "2026-11-09T19:00:00.000Z", verdict: "confirmed", verified_by: "jake" },
      { ...base, id: "d2", text: "Deploy with Argo.", at: "2026-11-09T19:01:00.000Z", confidence: 0.82 },
      { ...base, id: "d3", text: "Cluster team is JAM.", at: "2026-11-09T19:02:00.000Z", verdict: "rejected" },
    ]);
    const res = await call("context_decisions", {});
    expect(res.text).toContain("[confirmed] 2026-11-09T19:00:00.000Z cam [decision] d1");
    expect(res.text).toContain("[unconfirmed 0.82] 2026-11-09T19:01:00.000Z");
    expect(res.text).not.toContain("Cluster team");
  });

  it("item_verdict confirms or rejects as agent:<who>, publishes, and errors on unknown ids", async () => {
    const { store, call, published } = setup();
    await store.indexItems([
      { team_id: "t1", id: "d1", kind: "decision", text: "Name is JAM.", who: "cam", at: "2026-11-09T19:00:00.000Z", tags: [], raw_ids: [], status: "open" },
    ]);
    const res = await call("item_verdict", { id: "d1", verdict: "rejected" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("rejected by agent:opus-1");
    const stored = await store.itemById("t1", "d1");
    expect(stored).toMatchObject({ verdict: "rejected", verified_by: "agent:opus-1" });
    expect(published).toEqual([{ event: "item", data: stored }]);
    expect((await call("item_verdict", { id: "d1", verdict: "confirmed" }, "team_id=t2&who=x")).isError).toBe(true);
  });

  it("returns a tool error, not a 500, when the store throws", async () => {
    const { store, call } = setup();
    store.recent = async () => {
      throw new Error("elastic down");
    };
    const res = await call("context_recent", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("elastic down");
  });

  it("rejects a missing team_id with 400 and non-POST with 405", async () => {
    const { post, store } = setup();
    const res = await post("tools/list", {}, "who=opus-1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/team_id/);
    const bad = await post("tools/list", {}, "team_id=t1&side=middle");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/side/);
    const get = await handleMcpRequest(new Request("http://localhost/mcp?team_id=t1"), { store, dispatcher: fakeDispatcher(store) });
    expect(get.status).toBe(405);
  });
});

describe("task tools", () => {
  const A = "team_id=t1&who=opus-a&side=backend";
  const B = "team_id=t1&who=opus-b&side=backend";

  it("context_add carries the session side, and context_recent filters by it", async () => {
    const { call, store } = setup();
    await call("context_add", { text: "backend note" }, A);
    await call("context_add", { text: "frontend note" }, "team_id=t1&who=s1&side=frontend");
    const raw = await store.recent({ team_id: "t1", limit: 10 });
    expect(raw.find((d) => d.text === "backend note")?.side).toBe("backend");
    const recent = await call("context_recent", { side: "frontend" });
    expect(recent.text).toContain("frontend note");
    expect(recent.text).toContain("(frontend)");
    expect(recent.text).not.toContain("backend note");
  });

  it("claim is granted, listed, published and recorded in the brain", async () => {
    const { call, published, store } = setup();
    const res = await call("task_claim", { title: "stats route", paths: ["apps/api/"] }, A);
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/Claimed task [0-9a-f-]{36}, you hold apps\/api\..*task_done/);
    const list = await call("task_list", {}, B);
    expect(list.text).toContain("[claimed] backend · agent:opus-a · stats route");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ event: "task", data: { owner: "agent:opus-a", status: "claimed" } });
    const raw = await store.recent({ team_id: "t1", limit: 10 });
    expect(raw[0]?.text).toBe("[task claimed] stats route — agent:opus-a is editing apps/api");
    expect(raw[0]?.source_ref).toMatch(/^task:/);
  });

  it("refuses an overlapping claim from another agent, naming the owner", async () => {
    const { call } = setup();
    await call("task_claim", { title: "stats route", paths: ["apps/api/"] }, A);
    const res = await call("task_claim", { title: "fix app", paths: ["apps/api/src/app.ts"] }, B);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("already claimed by agent:opus-a");
    expect(res.text).toMatch(/- agent:opus-a: "stats route" holds apps\/api \(task /);
  });

  it("refuses a claim into the other side's paths", async () => {
    const { call } = setup();
    const res = await call("task_claim", { title: "restyle", paths: ["apps/web/src/App.tsx"] }, A);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("belongs to the other side");
  });

  it("refuses a claim when the url has no side, with the fix", async () => {
    const { call } = setup();
    const res = await call("task_claim", { title: "x", paths: ["README.md"] }, "team_id=t1&who=opus-a");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("&side=backend|frontend");
  });

  it("task_done frees the paths for the next agent", async () => {
    const { call, published } = setup();
    const claim = await call("task_claim", { title: "stats route", paths: ["apps/api/"] }, A);
    const id = claim.text.match(/Claimed task ([0-9a-f-]{36}),/)?.[1];
    const done = await call("task_done", { id, pr: "42" }, A);
    expect(done.isError).toBeFalsy();
    expect(done.text).toContain("done. Freed apps/api");
    expect(published.at(-1)).toMatchObject({ event: "task", data: { status: "done", pr: "42" } });
    expect((await call("task_list", {}, B)).text).toBe("No open claims.");
    const again = await call("task_claim", { title: "fix app", paths: ["apps/api/src/app.ts"] }, B);
    expect(again.isError).toBeFalsy();
    const unknown = await call("task_done", { id: "nope" }, A);
    expect(unknown.isError).toBe(true);
  });

  it("still grants the claim when the brain write fails", async () => {
    const { call, store } = setup();
    const deps = { store, dispatcher: fakeDispatcher(store) };
    deps.dispatcher.dispatch = async () => {
      throw new Error("worker down");
    };
    const res = await handleMcpRequest(
      new Request(`http://localhost/mcp?${A}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "task_claim", arguments: { title: "t", paths: ["apps/api/"] } },
        }),
      }),
      deps,
    );
    const body = await res.json();
    expect(body.result.isError).toBeFalsy();
    expect((await call("task_list", {})).text).toContain("agent:opus-a");
  });
});
