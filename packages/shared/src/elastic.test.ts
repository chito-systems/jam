import type { estypes } from "@elastic/elasticsearch";
import { describe, expect, it, vi } from "vitest";
import { createStoreFromEnv } from "./create-store";
import {
  buildFilters,
  buildHybridRequest,
  type ElasticClientLike,
  ElasticStore,
  rawMapping,
} from "./elastic";
import { MemoryStore } from "./store";
import { type ItemDoc, type RawDoc, SearchParamsSchema } from "./types";

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
const opts = { rawIndex: "raw_x", itemsIndex: "items_x" };

const searchRes = (hits: Array<{ _index: string; _score?: number; _source: unknown }>) =>
  ({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, failed: 0 },
    hits: { hits: hits.map((h, n) => ({ _id: String(n), ...h })) },
  }) as estypes.SearchResponse<unknown>;

function fakeClient() {
  const client = {
    indices: { create: vi.fn<ElasticClientLike["indices"]["create"]>(async () => ({})) },
    bulk: vi.fn<ElasticClientLike["bulk"]>(async () => ({ errors: false, items: [], took: 1 })),
    search: vi.fn<ElasticClientLike["search"]>(async () => searchRes([])),
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
  });

  it("ensureReady tolerates indices that already exist, and sets no shard settings", async () => {
    const exists = Object.assign(new Error("exists"), {
      meta: { body: { error: { type: "resource_already_exists_exception" } } },
    });
    const client = fakeClient();
    client.indices.create.mockRejectedValueOnce(exists);
    await new ElasticStore(client, opts).ensureReady();
    expect(client.indices.create).toHaveBeenCalledTimes(2);
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

describe("createStoreFromEnv", () => {
  it("picks memory by default and elastic when a URL is set", () => {
    expect(createStoreFromEnv({})).toBeInstanceOf(MemoryStore);
    expect(createStoreFromEnv({ STORE: "" })).toBeInstanceOf(MemoryStore); // .env.example ships STORE=
    expect(createStoreFromEnv({ STORE: "memory", ELASTIC_URL: "http://x:9200" })).toBeInstanceOf(MemoryStore);
    const store = createStoreFromEnv({ ELASTIC_URL: "http://x:9200" });
    expect(store).toBeInstanceOf(ElasticStore);
    expect((store as ElasticStore).opts).toEqual({ rawIndex: "context_raw", itemsIndex: "context_items" });
  });

  it("never falls back to memory when elastic is asked for", () => {
    expect(() => createStoreFromEnv({ STORE: "elastic" })).toThrow(/ELASTIC_URL/);
    expect(() => createStoreFromEnv({ STORE: "postgres" })).toThrow();
  });
});
