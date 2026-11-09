import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store";
import { type RawDoc, RawDocSchema, SearchParamsSchema } from "./types";

const raw = (over: Partial<RawDoc>): RawDoc =>
  RawDocSchema.parse({
    team_id: "t1",
    id: "c1:0",
    capture_id: "c1",
    type: "voice",
    who: "cam",
    at: "2026-11-09T19:00:00.000Z",
    seq: 0,
    text: "we decided to use the merge queue",
    ...over,
  });

describe("MemoryStore", () => {
  it("refuses to overwrite a raw doc (immutability)", async () => {
    const store = new MemoryStore();
    await store.indexRaw([raw({})]);
    await expect(store.indexRaw([raw({ text: "edited" })])).rejects.toThrow(/immutable/);
  });

  it("scopes search and recent by team", async () => {
    const store = new MemoryStore();
    await store.indexRaw([raw({}), raw({ id: "c2:0", capture_id: "c2", team_id: "t2" })]);
    const res = await store.search(SearchParamsSchema.parse({ team_id: "t1", q: "merge queue" }));
    expect(res.hits.map((h) => h.doc.id)).toEqual(["c1:0"]);
    expect(await store.recent({ team_id: "t2", limit: 20 })).toHaveLength(1);
  });

  it("returns recent newest first and honors the before cursor", async () => {
    const store = new MemoryStore();
    await store.indexRaw([
      raw({}),
      raw({ id: "c3:0", capture_id: "c3", at: "2026-11-09T19:05:00.000Z" }),
    ]);
    const docs = await store.recent({ team_id: "t1", limit: 20 });
    expect(docs.map((d) => d.id)).toEqual(["c3:0", "c1:0"]);
    const older = await store.recent({ team_id: "t1", limit: 20, before: "2026-11-09T19:05:00.000Z" });
    expect(older.map((d) => d.id)).toEqual(["c1:0"]);
  });
});

describe("contract", () => {
  it("rejects non-UTC timestamps", () => {
    expect(() => raw({ at: "2026-11-09 12:00" })).toThrow();
  });
});
