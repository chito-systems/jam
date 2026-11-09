import type { estypes } from "@elastic/elasticsearch";
import { describe, expect, it, vi } from "vitest";
import { createStoreFromEnv } from "./create-store";
import {
  buildFilters,
  buildHybridRequest,
  type ElasticClientLike,
  ElasticStore,
  rawMapping,
  tasksMapping,
} from "./elastic";
import { MemoryStore } from "./store";
import { type ItemDoc, type RawDoc, SearchParamsSchema, type TaskDoc, TaskDocSchema } from "./types";

const raw: RawDoc = {
  team_id: "t1",
  id: "c1:0",
  capture_id: "c1",
  type: "voice",
  who: "cam",
  at: "2026-11-09T19:00:00.000Z",
  seq: 0,
  text: "we decided to use the merge queue",
};
const item: ItemDoc = {
  team_id: "t1",
  id: "i1",
  kind: "decision",
  text: "Use the merge queue.",
  who: "cam",
  at: "2026-11-09T19:01:00.000Z",
  tags: [],
  raw_ids: ["c1:0"],
  status: "open",
};
const task: TaskDoc = {
  team_id: "t1",
  id: "task1",
  title: "wire the delegator",
  side: "backend",
  owner: "agent:opus-1",
  paths: ["apps/api/"],
  status: "claimed",
  created_at: "2026-11-09T19:02:00.000Z",
  updated_at: "2026-11-09T19:02:00.000Z",
};
const opts = { rawIndex: "raw_x", itemsIndex: "items_x", tasksIndex: "tasks_x" };
const shards = { total: 1, successful: 1, failed: 0 };

const searchRes = (hits: Array<{ _index: string; _score?: number; _source: unknown }>) =>
  ({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, failed: 0 },
    hits: { hits: hits.map((h, n) => ({ _id: String(n), ...h })) },
  }) as estypes.SearchResponse<unknown>;

function fakeClient() {
  const client = {
    indices: {
      create: vi.fn<ElasticClientLike["indices"]["create"]>(async () => ({})),
      putMapping: vi.fn<ElasticClientLike["indices"]["putMapping"]>(async () => ({})),
    },
    bulk: vi.fn<ElasticClientLike["bulk"]>(async () => ({ errors: false, items: [], took: 1 })),
    index: vi.fn<ElasticClientLike["index"]>(async () => ({})),
    search: vi.fn<ElasticClientLike["search"]>(async () => searchRes([])),
    count: vi.fn<ElasticClientLike["count"]>(async () => ({ count: 0, _shards: shards })),
    ping: vi.fn<ElasticClientLike["ping"]>(async () => true),
  };
  return client;
}

const params = SearchParamsSchema.parse({ team_id: "t1", q: "merge queue", who: "cam" });

describe("mappings", () => {
  it("is strict and copies text into semantic_text", () => {
    const m = rawMapping();
    expect(m.dynamic).toBe("strict");
    expect(m.properties?.text).toEqual({ type: "text", copy_to: "text_semantic" });
    expect(m.properties?.text_semantic).toEqual({ type: "semantic_text" });
    expect(rawMapping("my-e5").properties?.text_semantic).toEqual({
      type: "semantic_text",
      inference_id: "my-e5",
    });
    expect(m.properties?.side).toEqual({ type: "keyword" });
  });

  it("maps tasks strictly: keywords, text title/note/spec/reason, dates", () => {
    const m = tasksMapping();
    expect(m.dynamic).toBe("strict");
    const keywords = ["team_id", "id", "side", "owner", "paths", "status", "pr"];
    for (const f of [...keywords, "item_id", "raw_ids", "proposed_by", "suggested_owner"]) {
      expect(m.properties?.[f]).toEqual({ type: "keyword" });
    }
    for (const f of ["title", "note", "spec", "reason"]) expect(m.properties?.[f]).toEqual({ type: "text" });
    // dynamic: strict rejects any field the mapping lacks, so every TaskDoc field must be mapped.
    expect(Object.keys(TaskDocSchema.shape).filter((f) => !m.properties?.[f])).toEqual([]);
    expect(m.properties?.created_at).toEqual({ type: "date" });
    expect(m.properties?.updated_at).toEqual({ type: "date" });
  });

  it("ensureReady put-maps new fields onto an existing index, without semantic_text", async () => {
    const exists = Object.assign(new Error("exists"), {
      meta: { body: { error: { type: "resource_already_exists_exception" } } },
    });
    const client = fakeClient();
    client.indices.create.mockRejectedValueOnce(exists);
    await new ElasticStore(client, opts).ensureReady();
    expect(client.indices.create.mock.calls[2]?.[0].index).toBe("tasks_x");
    expect(client.indices.putMapping).toHaveBeenCalledTimes(1);
    const put = client.indices.putMapping.mock.calls[0]?.[0];
    expect(put?.index).toBe("raw_x");
    expect(put?.properties?.side).toEqual({ type: "keyword" });
    expect(put?.properties?.text).toEqual({ type: "text", copy_to: "text_semantic" });
    expect(put?.properties?.text_semantic).toBeUndefined();
  });

  it("ensureReady tolerates indices that already exist, and sets no shard settings", async () => {
    const exists = Object.assign(new Error("exists"), {
      meta: { body: { error: { type: "resource_already_exists_exception" } } },
    });
    const client = fakeClient();
    client.indices.create.mockRejectedValueOnce(exists);
    await new ElasticStore(client, opts).ensureReady();
    expect(client.indices.create).toHaveBeenCalledTimes(3);
    const first = client.indices.create.mock.calls[0];
    expect(first?.[0].index).toBe("raw_x");
    expect(first?.[0].settings).toBeUndefined();
  });
});

describe("indexRaw", () => {
  it("bulk-creates with the doc id and waits for refresh", async () => {
    const client = fakeClient();
    await new ElasticStore(client, opts).indexRaw([raw]);
    expect(client.bulk).toHaveBeenCalledWith({
      refresh: "wait_for",
      operations: [{ create: { _index: "raw_x", _id: "c1:0" } }, raw],
    });
  });

  it("turns a 409 into the immutability error", async () => {
    const client = fakeClient();
    client.bulk.mockResolvedValue({
      errors: true,
      took: 1,
      items: [{ create: { _index: "raw_x", _id: "c1:0", status: 409, error: { type: "version_conflict_engine_exception" } } }],
    });
    await expect(new ElasticStore(client, opts).indexRaw([raw])).rejects.toThrow(
      "context_raw is immutable: c1:0 already exists",
    );
  });

  it("is a no-op for an empty batch", async () => {
    const client = fakeClient();
    await new ElasticStore(client, opts).indexRaw([]);
    expect(client.bulk).not.toHaveBeenCalled();
  });
});

describe("search", () => {
  it("builds one rrf request with the same filters on both retrievers", () => {
    const req = buildHybridRequest(params, ["raw_x", "items_x"]);
    expect(req.index).toEqual(["raw_x", "items_x"]);
    const rrf = req.retriever?.rrf;
    expect(rrf?.retrievers).toHaveLength(2);
    const filters = buildFilters(params);
    expect(filters).toEqual([{ term: { team_id: "t1" } }, { term: { who: "cam" } }]);
    expect(JSON.stringify(rrf)).toContain('"semantic":{"field":"text_semantic","query":"merge queue"}');
    expect(JSON.stringify(rrf)).toContain('"match":{"text":"merge queue"}');
    for (const r of rrf?.retrievers ?? []) {
      expect(JSON.stringify(r)).toContain(JSON.stringify(filters));
    }
  });

  it("filters by side in both retrievers and in recent (side excludes items)", async () => {
    const p = SearchParamsSchema.parse({ team_id: "t1", q: "x", side: "frontend" });
    expect(buildFilters(p)).toEqual([{ term: { team_id: "t1" } }, { term: { side: "frontend" } }]);
    const retrievers = buildHybridRequest(p, ["raw_x", "items_x"]).retriever?.rrf?.retrievers ?? [];
    expect(retrievers).toHaveLength(2);
    for (const r of retrievers) expect(JSON.stringify(r)).toContain('{"term":{"side":"frontend"}}');
    const client = fakeClient();
    await new ElasticStore(client, opts).recent({ team_id: "t1", limit: 5, side: "backend" });
    expect(client.search.mock.calls[0]?.[0].query).toEqual({
      bool: { filter: [{ term: { team_id: "t1" } }, { term: { side: "backend" } }] },
    });
  });

  it("maps both layers and attaches linked items to raw hits", async () => {
    const client = fakeClient();
    client.search
      .mockResolvedValueOnce(
        searchRes([
          { _index: "raw_x", _score: 0.5, _source: raw },
          { _index: "items_x", _score: 0.3, _source: item },
        ]),
      )
      .mockResolvedValueOnce(searchRes([{ _index: "items_x", _source: item }]));
    const res = await new ElasticStore(client, opts).search(params);
    expect(res.mode).toBe("hybrid");
    expect(res.hits).toEqual([
      { layer: "raw", score: 0.5, doc: raw, items: [item] },
      { layer: "item", score: 0.3, doc: item },
    ]);
  });

  it("falls back to keyword, warning once, when hybrid throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient();
    client.search.mockImplementation(async (req) => {
      if (req.retriever) throw new Error("inference endpoint not found");
      return searchRes([]);
    });
    const store = new ElasticStore(client, opts);
    expect((await store.search(params)).mode).toBe("keyword");
    expect((await store.search(params)).mode).toBe("keyword");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("recent and ping", () => {
  it("sorts newest first and applies the before cursor", async () => {
    const client = fakeClient();
    await new ElasticStore(client, opts).recent({ team_id: "t1", limit: 5, before: raw.at });
    expect(client.search).toHaveBeenCalledWith({
      index: "raw_x",
      size: 5,
      query: { bool: { filter: [{ term: { team_id: "t1" } }, { range: { at: { lt: raw.at } } }] } },
      sort: [{ at: "desc" }, { seq: "desc" }],
    });
  });

  it("ping never throws", async () => {
    const client = fakeClient();
    client.ping.mockRejectedValue(new Error("down"));
    expect(await new ElasticStore(client, opts).ping()).toBe(false);
  });
});

describe("rawByIds", () => {
  it("is one terms query on id, scoped to the team, sized to the deduped ids", async () => {
    const client = fakeClient();
    client.search.mockResolvedValueOnce(searchRes([{ _index: "raw_x", _source: raw }]));
    const docs = await new ElasticStore(client, opts).rawByIds("t1", ["c1:0", "c2:0", "c1:0"]);
    expect(docs).toEqual([raw]);
    expect(client.search).toHaveBeenCalledWith({
      index: "raw_x",
      size: 2,
      query: { bool: { filter: [{ term: { team_id: "t1" } }, { terms: { id: ["c1:0", "c2:0"] } }] } },
    });
  });

  it("sends nothing for no ids and caps a huge list at 500", async () => {
    const client = fakeClient();
    const store = new ElasticStore(client, opts);
    expect(await store.rawByIds("t1", [])).toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
    await store.rawByIds("t1", Array.from({ length: 900 }, (_, n) => `c:${n}`));
    expect(client.search.mock.calls[0]?.[0].size).toBe(500);
  });

  it("MemoryStore returns only this team's chunks and skips missing ids", async () => {
    const mem = new MemoryStore();
    await mem.indexRaw([raw, { ...raw, id: "c9:0", team_id: "other" }]);
    expect(await mem.rawByIds("t1", ["c1:0", "c9:0", "nope"])).toEqual([raw]);
    expect(await mem.rawByIds("t1", [])).toEqual([]);
  });
});

describe("tasks and counts", () => {
  it("upserts a task by id and waits for refresh", async () => {
    const client = fakeClient();
    await new ElasticStore(client, opts).upsertTask(task);
    expect(client.index).toHaveBeenCalledWith({ index: "tasks_x", id: "task1", document: task, refresh: "wait_for" });
  });

  it("filters tasks by team/status/side, newest first, and parses", async () => {
    const client = fakeClient();
    client.search.mockResolvedValueOnce(searchRes([{ _index: "tasks_x", _source: task }]));
    const store = new ElasticStore(client, opts);
    expect(await store.tasks({ team_id: "t1", status: "claimed", side: "backend", limit: 7 })).toEqual([task]);
    expect(client.search).toHaveBeenCalledWith({
      index: "tasks_x",
      size: 7,
      query: {
        bool: { filter: [{ term: { team_id: "t1" } }, { term: { status: "claimed" } }, { term: { side: "backend" } }] },
      },
      sort: [{ created_at: "desc" }],
    });
  });

  it("maps aggregations and the items count into StoreCounts", async () => {
    const client = fakeClient();
    client.search.mockResolvedValueOnce({
      ...searchRes([]),
      hits: { total: { value: 5, relation: "eq" }, hits: [] },
      aggregations: {
        by_who: { buckets: [{ key: "cam", doc_count: 3 }, { key: "jake", doc_count: 2 }] },
        by_type: { buckets: [{ key: "voice", doc_count: 5 }] },
        by_side: { buckets: [{ key: "backend", doc_count: 4 }] },
      },
    } as estypes.SearchResponse<unknown>);
    client.count.mockResolvedValueOnce({ count: 2, _shards: shards });
    expect(await new ElasticStore(client, opts).counts("t1")).toEqual({
      raw_total: 5,
      items_total: 2,
      by_who: { cam: 3, jake: 2 },
      by_type: { voice: 5 },
      by_side: { backend: 4 },
    });
    const req = client.search.mock.calls[0]?.[0];
    expect(req).toMatchObject({ index: "raw_x", size: 0, track_total_hits: true });
    expect(req?.aggs?.by_side).toEqual({ terms: { field: "side", size: 50 } });
    expect(client.count.mock.calls[0]?.[0]).toEqual({
      index: "items_x",
      query: { bool: { filter: [{ term: { team_id: "t1" } }] } },
    });
  });
});

describe("createStoreFromEnv", () => {
  it("picks memory by default and elastic when a URL is set", () => {
    expect(createStoreFromEnv({})).toBeInstanceOf(MemoryStore);
    expect(createStoreFromEnv({ STORE: "" })).toBeInstanceOf(MemoryStore); // .env.example ships STORE=
    expect(createStoreFromEnv({ STORE: "memory", ELASTIC_URL: "http://x:9200" })).toBeInstanceOf(MemoryStore);
    const store = createStoreFromEnv({ ELASTIC_URL: "http://x:9200" });
    expect(store).toBeInstanceOf(ElasticStore);
    expect((store as ElasticStore).opts).toEqual({
      rawIndex: "context_raw",
      itemsIndex: "context_items",
      tasksIndex: "context_tasks",
    });
  });

  it("never falls back to memory when elastic is asked for", () => {
    expect(() => createStoreFromEnv({ STORE: "elastic" })).toThrow(/ELASTIC_URL/);
    expect(() => createStoreFromEnv({ STORE: "postgres" })).toThrow();
  });
});

describe("grading", () => {
  it("maps confidence/verdict fields and put-maps them onto an existing items index", async () => {
    const exists = Object.assign(new Error("exists"), {
      meta: { body: { error: { type: "resource_already_exists_exception" } } },
    });
    const client = fakeClient();
    client.indices.create.mockResolvedValueOnce({}).mockRejectedValueOnce(exists);
    await new ElasticStore(client, opts).ensureReady();
    const put = client.indices.putMapping.mock.calls[0]?.[0];
    expect(put?.index).toBe("items_x");
    expect(put?.properties?.confidence).toEqual({ type: "float" });
    expect(put?.properties?.verdict).toEqual({ type: "keyword" });
    expect(put?.properties?.verified_by).toEqual({ type: "keyword" });
    expect(put?.properties?.verified_at).toEqual({ type: "date" });
  });

  it("filters items by verdict and fetches one item by team + id", async () => {
    const client = fakeClient();
    client.search.mockResolvedValue(searchRes([{ _index: "items_x", _source: { ...item, verdict: "confirmed" } }]));
    const store = new ElasticStore(client, opts);
    await store.items({ team_id: "t1", verdict: "confirmed", limit: 5 });
    expect(JSON.stringify(client.search.mock.calls[0]?.[0].query)).toContain('{"term":{"verdict":"confirmed"}}');
    expect(await store.itemById("t1", "i1")).toMatchObject({ id: "i1", verdict: "confirmed" });
    expect(client.search.mock.calls[1]?.[0].query).toEqual({
      bool: { filter: [{ term: { team_id: "t1" } }, { term: { id: "i1" } }] },
    });
    client.search.mockResolvedValue(searchRes([]));
    expect(await store.itemById("t1", "nope")).toBeUndefined();
  });

  it("MemoryStore filters by verdict and scopes itemById to the team", async () => {
    const store = new MemoryStore();
    await store.indexItems([item, { ...item, id: "i2", verdict: "rejected" }]);
    expect((await store.items({ team_id: "t1", verdict: "rejected", limit: 5 })).map((i) => i.id)).toEqual(["i2"]);
    expect(await store.itemById("t1", "i2")).toMatchObject({ verdict: "rejected" });
    expect(await store.itemById("t2", "i2")).toBeUndefined();
  });
});
