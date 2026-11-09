import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store";
import { acceptTask, claimTask, closeTask, normalizePath, pathsOverlap, sideOf } from "./tasks";
import type { TaskAcceptRequest, TaskDoc } from "./types";

const claim = (store: MemoryStore, who: string, side: "backend" | "frontend", paths: string[]) =>
  claimTask(store, { team_id: "t1", who, side, title: `${who} task`, paths });

describe("paths", () => {
  it("normalizes globs and slashes", () => {
    expect(normalizePath("./apps/api/src/**")).toBe("apps/api/src");
    expect(normalizePath("/apps/web/")).toBe("apps/web");
  });

  it("overlaps on containment, not on shared name prefixes", () => {
    expect(pathsOverlap("apps/api", "apps/api/src/app.ts")).toBe(true);
    expect(pathsOverlap("apps/api/src/app.ts", "apps/api/src/app.ts")).toBe(true);
    expect(pathsOverlap("apps/api", "apps/api-old/x.ts")).toBe(false);
    expect(pathsOverlap("apps/api/src/a.ts", "apps/api/src/b.ts")).toBe(false);
  });

  it("knows which side owns a path", () => {
    expect(sideOf("apps/web/src/App.tsx")).toBe("frontend");
    expect(sideOf("packages/shared/src/types.ts")).toBe("backend");
    expect(sideOf("Dockerfile")).toBe("backend");
    expect(sideOf("PITCH.md")).toBeUndefined();
  });
});

describe("claimTask", () => {
  it("grants a claim on free paths in your own side", async () => {
    const store = new MemoryStore();
    const res = await claim(store, "agent:opus-1", "backend", ["apps/api/src/app.ts"]);
    expect(res.ok && res.task.status).toBe("claimed");
    expect(await store.tasks({ team_id: "t1", limit: 50 })).toHaveLength(1);
  });

  it("refuses a path that belongs to the other side", async () => {
    const res = await claim(new MemoryStore(), "agent:opus-1", "backend", ["apps/web/src/App.tsx"]);
    expect(!res.ok && res.conflict.reason).toBe("wrong_side");
  });

  it("refuses an overlap with an open claim and names the holder", async () => {
    const store = new MemoryStore();
    await claim(store, "agent:opus-1", "backend", ["apps/api/"]);
    const res = await claim(store, "agent:opus-2", "backend", ["apps/api/src/app.ts", "apps/worker/"]);
    expect(!res.ok && res.conflict.reason).toBe("overlap");
    expect(!res.ok && res.conflict.offending_paths).toEqual(["apps/api/src/app.ts"]);
    expect(!res.ok && res.conflict.error).toContain("agent:opus-1");
  });

  it("frees the paths once the task is closed", async () => {
    const store = new MemoryStore();
    const first = await claim(store, "agent:opus-1", "backend", ["apps/api/"]);
    if (!first.ok) throw new Error("expected a claim");
    const closed = await closeTask(store, first.task.id, {
      team_id: "t1",
      who: "agent:opus-1",
      status: "done",
      pr: "42",
    });
    expect(closed?.status).toBe("done");
    expect((await claim(store, "agent:opus-2", "backend", ["apps/api/src/app.ts"])).ok).toBe(true);
  });

  it("lets either side claim shared ground, and isolates teams", async () => {
    const store = new MemoryStore();
    expect((await claim(store, "jake", "frontend", ["PITCH.md"])).ok).toBe(true);
    const other = await claimTask(store, {
      team_id: "t2",
      who: "x",
      side: "backend",
      title: "t",
      paths: ["PITCH.md"],
    });
    expect(other.ok).toBe(true);
  });

  it("returns undefined when closing an unknown task", async () => {
    const res = await closeTask(new MemoryStore(), "nope", { team_id: "t1", who: "x", status: "done" });
    expect(res).toBeUndefined();
  });

  it("ignores proposed work orders: they hold no paths", async () => {
    const store = new MemoryStore();
    await store.upsertTask(proposed("wo1", ["apps/api/"]));
    expect((await claim(store, "agent:opus-1", "backend", ["apps/api/src/app.ts"])).ok).toBe(true);
  });
});

const AT = "2026-11-09T19:00:00.000Z";
const proposed = (id: string, paths: string[], extra: Partial<TaskDoc> = {}): TaskDoc => ({
  team_id: "t1",
  id,
  title: `work order ${id}`,
  side: "backend",
  owner: "jam",
  paths,
  status: "proposed",
  spec: "# Build it\nAcceptance: tests pass.",
  item_id: "item-1",
  raw_ids: ["raw-1"],
  proposed_by: "jam",
  suggested_owner: "cam",
  reason: "backend path",
  created_at: AT,
  updated_at: AT,
  ...extra,
});

describe("acceptTask", () => {
  const accept = (store: MemoryStore, id: string, who: string, extra: Partial<TaskAcceptRequest> = {}) =>
    acceptTask(store, id, { team_id: "t1", who, ...extra });

  it("turns a proposed work order into a claim that blocks overlapping claims, keeping the spec", async () => {
    const store = new MemoryStore();
    await store.upsertTask(proposed("wo1", ["./apps/api/src/**"]));
    const res = await accept(store, "wo1", "cam");
    if (!res.ok) throw new Error("expected accept");
    expect(res.task).toMatchObject({
      id: "wo1",
      status: "claimed",
      owner: "cam",
      paths: ["apps/api/src"],
      side: "backend",
      spec: "# Build it\nAcceptance: tests pass.",
      item_id: "item-1",
      raw_ids: ["raw-1"],
      proposed_by: "jam",
      suggested_owner: "cam",
      reason: "backend path",
    });
    const blocked = await claim(store, "agent:opus-2", "backend", ["apps/api/src/app.ts"]);
    expect(!blocked.ok && blocked.conflict.reason).toBe("overlap");
  });

  it("uses the paths and side passed in over the proposed ones", async () => {
    const store = new MemoryStore();
    await store.upsertTask(proposed("wo1", []));
    const res = await accept(store, "wo1", "jake", { side: "frontend", paths: ["apps/web/src/App.tsx"] });
    expect(res.ok && res.task).toMatchObject({ side: "frontend", paths: ["apps/web/src/App.tsx"] });
  });

  it("refuses when another claim already holds the paths", async () => {
    const store = new MemoryStore();
    await claim(store, "agent:opus-1", "backend", ["apps/api/"]);
    await store.upsertTask(proposed("wo1", ["apps/api/src/app.ts"]));
    const res = await accept(store, "wo1", "cam");
    expect(!res.ok && "conflict" in res && res.conflict.reason).toBe("overlap");
    expect((await store.tasks({ team_id: "t1", status: "proposed", limit: 10 })).map((t) => t.id)).toEqual(["wo1"]);
  });

  it("refuses paths on the other side", async () => {
    const store = new MemoryStore();
    await store.upsertTask(proposed("wo1", ["apps/web/src/"]));
    const res = await accept(store, "wo1", "cam");
    expect(!res.ok && "conflict" in res && res.conflict.reason).toBe("wrong_side");
  });

  it("errors on a non-proposed task, a work order with no paths, and an unknown id", async () => {
    const store = new MemoryStore();
    await store.upsertTask(proposed("done1", ["apps/api/"], { status: "done" }));
    await store.upsertTask(proposed("empty", []));
    expect(await accept(store, "done1", "cam")).toEqual({ ok: false, error: "task is already done" });
    expect(await accept(store, "empty", "cam")).toEqual({
      ok: false,
      error: "this work order has no paths yet: pass the paths you will edit",
    });
    expect(await accept(store, "nope", "cam")).toEqual({ ok: false, notFound: true });
  });
});
