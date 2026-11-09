import { describe, expect, it } from "vitest";
import { parseRoster } from "./assign";
import { clashText, ownershipMap, ownershipOf } from "./ownership";
import { MemoryStore } from "./store";
import { claimTask } from "./tasks";
import type { TaskDoc } from "./types";

const roster = parseRoster("cam:backend,jake:frontend");
const at = "2026-11-09T19:00:00.000Z";
const order: TaskDoc = {
  team_id: "t1", id: "wo1", title: "tidy app", side: "backend", owner: "jam", paths: ["apps/api/src"],
  status: "proposed", created_at: at, updated_at: at,
};

async function seeded() {
  const store = new MemoryStore();
  await claimTask(store, { team_id: "t1", who: "agent:a", side: "backend", title: "stats", paths: ["apps/api/"] });
  await store.upsertTask(order);
  return store;
}

describe("ownershipOf", () => {
  it("backend file with an open claim and a proposed work order", async () => {
    const res = await ownershipOf(await seeded(), { team_id: "t1", path: "./apps/api/src/app.ts", roster });
    expect(res).toMatchObject({ path: "apps/api/src/app.ts", side: "backend", captain: "cam" });
    expect(res.held_by.map((t) => t.owner)).toEqual(["agent:a"]);
    expect(res.proposed.map((t) => t.id)).toEqual(["wo1"]);
  });

  it("frontend file nobody holds", async () => {
    const res = await ownershipOf(await seeded(), { team_id: "t1", path: "apps/web/src/App.tsx", roster });
    expect(res).toEqual({ path: "apps/web/src/App.tsx", side: "frontend", captain: "jake", held_by: [], proposed: [] });
  });

  it("root doc is shared ground: no side, no captain", async () => {
    const res = await ownershipOf(await seeded(), { team_id: "t1", path: "PITCH.md", roster });
    expect(res).toEqual({ path: "PITCH.md", held_by: [], proposed: [] });
  });
});

describe("ownershipMap", () => {
  it("lists each side's prefixes, captain and open claims", async () => {
    const { sides } = await ownershipMap(await seeded(), { team_id: "t1", roster });
    expect(sides.map((s) => [s.side, s.captain])).toEqual([["backend", "cam"], ["frontend", "jake"]]);
    expect(sides[0]?.paths).toContain("apps/api/");
    expect(sides[0]?.claims).toEqual([{ id: expect.any(String), title: "stats", owner: "agent:a", paths: ["apps/api"] }]);
    expect(sides[1]).toMatchObject({ paths: ["apps/web/"], claims: [] });
  });
});

describe("clashText", () => {
  it("names the holder, or the other side", () => {
    const held = { ...order, owner: "agent:a", title: "stats", status: "claimed" as const };
    expect(clashText("agent:b", "backend", { error: "", reason: "overlap", offending_paths: ["apps/api/src"], conflicts: [held] }))
      .toBe('[clash] agent:b tried to claim apps/api/src but agent:a holds them for "stats"');
    expect(clashText("agent:b", "backend", { error: "", reason: "wrong_side", offending_paths: ["apps/web/x"], conflicts: [] }))
      .toBe("[clash] agent:b (backend) tried to claim apps/web/x, which belong to the frontend side");
  });
});
