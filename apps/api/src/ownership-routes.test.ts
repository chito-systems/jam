import { claimTask, MemoryStore, type OwnershipMapResponse, type OwnershipResponse, parseRoster } from "@hh/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerOwnershipRoutes } from "./ownership-routes";

async function setup() {
  const store = new MemoryStore();
  await claimTask(store, { team_id: "t1", who: "agent:a", side: "backend", title: "stats", paths: ["apps/api/"] });
  const app = new Hono();
  registerOwnershipRoutes(app, { store, roster: parseRoster("cam:backend,jake:frontend") });
  return app;
}

describe("GET /api/ownership", () => {
  it("answers for one path", async () => {
    const res = await (await setup()).request("/api/ownership?team_id=t1&path=apps/api/src/app.ts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OwnershipResponse;
    expect(body).toMatchObject({ path: "apps/api/src/app.ts", side: "backend", captain: "cam", proposed: [] });
    expect(body.held_by[0]).toMatchObject({ owner: "agent:a", title: "stats" });
  });

  it("returns the whole map without a path", async () => {
    const res = await (await setup()).request("/api/ownership?team_id=t1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OwnershipMapResponse;
    expect(body.sides.map((s) => s.side)).toEqual(["backend", "frontend"]);
    expect(body.sides[0]?.claims).toHaveLength(1);
  });

  it("400s without team_id", async () => {
    const res = await (await setup()).request("/api/ownership?path=README.md");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "team_id is required" });
  });
});
