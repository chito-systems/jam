import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store";
import { claimTask, closeTask, normalizePath, pathsOverlap, sideOf } from "./tasks";

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
});
