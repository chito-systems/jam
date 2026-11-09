import { type CaptureStatus, type Dispatcher, type IngestJob, MemoryStore } from "@hh/shared";
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "./index";

/** Indexes text jobs straight into the store, like the inline dispatcher will. */
function fakeDispatcher(store: MemoryStore): Dispatcher {
  return {
    async dispatch(job: IngestJob): Promise<CaptureStatus> {
      const id = `${job.capture_id}:0`;
      await store.indexRaw([
        { team_id: job.team_id, id, capture_id: job.capture_id, type: job.type, who: job.who, at: job.at, seq: 0, text: job.text ?? "", source_ref: job.source_ref },
      ]);
      return { capture_id: job.capture_id, team_id: job.team_id, who: job.who, type: job.type, state: "indexed", received_at: job.received_at, raw_ids: [id] };
    },
    async status() {
      return undefined;
    },
    subscribe() {
      return () => {};
    },
  };
}

function setup() {
  const store = new MemoryStore();
  const deps = { store, dispatcher: fakeDispatcher(store) };
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
  return { store, post, call };
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

  it("lists the four tools", async () => {
    const { post } = setup();
    const body = await (await post("tools/list", {})).json();
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["context_add", "context_decisions", "context_recent", "context_search"]);
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
    const get = await handleMcpRequest(new Request("http://localhost/mcp?team_id=t1"), { store, dispatcher: fakeDispatcher(store) });
    expect(get.status).toBe(405);
  });
});
