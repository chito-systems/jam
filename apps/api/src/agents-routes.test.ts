import { type AgentsResponse, createPresence, MemoryStore } from "@hh/shared";
import { createInlineDispatcher } from "@hh/worker";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

function setup() {
  const store = new MemoryStore();
  let t = Date.now();
  const now = () => {
    t += 10; // strictly increasing, still "active"
    return new Date(t);
  };
  const presence = createPresence({ now });
  return createApp({ store, dispatcher: createInlineDispatcher({ store }), presence });
}

const mcpCall = (app: ReturnType<typeof setup>, query: string, name: string, args: Record<string, unknown>) =>
  app.request(`/mcp?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

describe("GET /api/agents", () => {
  it("400s without team_id", async () => {
    const res = await setup().request("/api/agents");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "team_id is required" });
  });

  it("lists agents seen through MCP with their human, side and claims", async () => {
    const app = setup();
    const claim = await mcpCall(app, "team_id=t1&who=cam-opus-1&side=backend", "task_claim", {
      title: "agents route",
      paths: ["apps/api/"],
    });
    expect(claim.status).toBe(200);
    await mcpCall(app, "team_id=t1&who=jake-sonnet-2&side=frontend", "task_list", {});

    const res = await app.request("/api/agents?team_id=t1");
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as AgentsResponse;
    expect(agents.map((a) => [a.id, a.human, a.side, a.state])).toEqual([
      ["agent:jake-sonnet-2", "jake", "frontend", "active"],
      ["agent:cam-opus-1", "cam", "backend", "active"],
    ]);
    const cam = agents[1];
    expect(cam?.last_tool).toBe("task_claim");
    expect(cam?.calls).toBe(1);
    expect(cam?.claims.map((t) => t.title)).toEqual(["agents route"]);
  });
});
