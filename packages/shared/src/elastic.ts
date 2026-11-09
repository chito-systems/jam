// ElasticStore: the production ContextStore. Elasticsearch is the product's core data layer.
// Three indices: raw (immutable truth, create-only), items (the librarian's layer, upsert)
// and tasks (delegation claims, upsert).
// Search is one hybrid request: RRF over BM25 on `text` and semantic on `text_semantic`.
import type { estypes } from "@elastic/elasticsearch";
import type { ContextStore, StoreCounts } from "./store";
import { withSpan } from "./telemetry";
import {
  type ItemDoc,
  ItemDocSchema,
  type ItemsParams,
  type RawDoc,
  RawDocSchema,
  type RecentParams,
  type SearchHit,
  type SearchParams,
  type SearchResponse,
  type TaskDoc,
  TaskDocSchema,
  type TasksParams,
} from "./types";

/** The slice of the @elastic/elasticsearch Client we use. Tests pass a fake. */
export interface ElasticClientLike {
  indices: {
    create(params: estypes.IndicesCreateRequest): Promise<unknown>;
    putMapping(params: estypes.IndicesPutMappingRequest): Promise<unknown>;
  };
  bulk(params: estypes.BulkRequest): Promise<estypes.BulkResponse>;
  index(params: estypes.IndexRequest): Promise<unknown>;
  search(params: estypes.SearchRequest): Promise<estypes.SearchResponse<unknown>>;
  count(params: estypes.CountRequest): Promise<estypes.CountResponse>;
  ping(): Promise<boolean>;
}

export interface ElasticStoreOptions {
  rawIndex: string;
  itemsIndex: string;
  tasksIndex: string;
  /** Inference endpoint for semantic_text. Unset = Elasticsearch's default endpoint. */
  inferenceId?: string;
}

type Query = estypes.QueryDslQueryContainer;
const keyword = { type: "keyword" } as const;

function textPair(inferenceId?: string): Record<string, estypes.MappingProperty> {
  return {
    text: { type: "text", copy_to: "text_semantic" },
    text_semantic: inferenceId
      ? { type: "semantic_text", inference_id: inferenceId }
      : { type: "semantic_text" },
  };
}

export function rawMapping(inferenceId?: string): estypes.MappingTypeMapping {
  return {
    dynamic: "strict",
    properties: {
      team_id: keyword,
      id: keyword,
      capture_id: keyword,
      type: keyword,
      who: keyword,
      side: keyword,
      source_ref: keyword,
      at: { type: "date" },
      seq: { type: "integer" },
      duration_s: { type: "float" },
      ...textPair(inferenceId),
    },
  };
}

export function itemsMapping(inferenceId?: string): estypes.MappingTypeMapping {
  return {
    dynamic: "strict",
    properties: {
      team_id: keyword,
      id: keyword,
      kind: keyword,
      who: keyword,
      tags: keyword,
      raw_ids: keyword,
      status: keyword,
      at: { type: "date" },
      confidence: { type: "float" },
      verdict: keyword,
      verified_by: keyword,
      verified_at: { type: "date" },
      ...textPair(inferenceId),
    },
  };
}

export function tasksMapping(): estypes.MappingTypeMapping {
  return {
    dynamic: "strict",
    properties: {
      team_id: keyword,
      id: keyword,
      side: keyword,
      owner: keyword,
      paths: keyword,
      status: keyword,
      pr: keyword,
      title: { type: "text" },
      note: { type: "text" },
      created_at: { type: "date" },
      updated_at: { type: "date" },
    },
  };
}

/** Properties safe to re-send to an existing index: everything except semantic_text (its live definition
 * carries model_settings we don't want to fight). Adding fields to a mapping is idempotent. */
export function additiveProperties(m: estypes.MappingTypeMapping): Record<string, estypes.MappingProperty> {
  return Object.fromEntries(Object.entries(m.properties ?? {}).filter(([, p]) => p.type !== "semantic_text"));
}

/**
 * Shared filter for search. `type` and `side` only exist on raw docs, so filtering by either
 * excludes items.
 */
export function buildFilters(p: Pick<SearchParams, "team_id" | "who" | "since" | "type" | "side">): Query[] {
  const filters: Query[] = [{ term: { team_id: p.team_id } }];
  if (p.who) filters.push({ term: { who: p.who } });
  if (p.since) filters.push({ range: { at: { gte: p.since } } });
  if (p.type) filters.push({ term: { type: p.type } });
  if (p.side) filters.push({ term: { side: p.side } });
  return filters;
}

export function buildHybridRequest(p: SearchParams, indices: string[]): estypes.SearchRequest {
  const filter = buildFilters(p);
  return {
    index: indices,
    size: p.limit,
    retriever: {
      rrf: {
        rank_window_size: 50,
        retrievers: [
          { standard: { query: { bool: { must: [{ match: { text: p.q } }], filter } } } },
          {
            standard: {
              query: { bool: { must: [{ semantic: { field: "text_semantic", query: p.q } }], filter } },
            },
          },
        ],
      },
    },
  };
}

export function buildKeywordRequest(p: SearchParams, indices: string[]): estypes.SearchRequest {
  return {
    index: indices,
    size: p.limit,
    query: { bool: { must: [{ match: { text: p.q } }], filter: buildFilters(p) } },
  };
}

/** Pulls `error.type` out of an Elasticsearch ResponseError without importing the class. */
function esErrorType(err: unknown): string | undefined {
  const body = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body;
  return body?.error?.type;
}

/** Cap for one provenance lookup: well under index.max_result_window, plenty for one page of items. */
export const MAX_RAW_BY_IDS = 500;

let warnedKeywordFallback = false;

export class ElasticStore implements ContextStore {
  constructor(
    private readonly client: ElasticClientLike,
    readonly opts: ElasticStoreOptions,
  ) {}

  async ensureReady(): Promise<void> {
    const { rawIndex, itemsIndex, tasksIndex, inferenceId } = this.opts;
    for (const [index, mappings] of [
      [rawIndex, rawMapping(inferenceId)],
      [itemsIndex, itemsMapping(inferenceId)],
      [tasksIndex, tasksMapping()],
    ] as const) {
      try {
        await this.client.indices.create({ index, mappings });
      } catch (err) {
        if (esErrorType(err) !== "resource_already_exists_exception") throw err;
        // Existing index: bring it up to date with fields added since it was created (e.g. raw.side).
        await this.client.indices.putMapping({ index, properties: additiveProperties(mappings) });
      }
    }
  }

  /** Waits for refresh: the very next claim must see this one (it is the overlap guard). */
  async upsertTask(task: TaskDoc): Promise<void> {
    const index = this.opts.tasksIndex;
    await withSpan("elastic.upsert_task", { "es.index": index, "task.id": task.id }, async () => {
      await this.client.index({ index, id: task.id, document: task, refresh: "wait_for" });
    });
  }

  async tasks(params: TasksParams): Promise<TaskDoc[]> {
    const filter: Query[] = [{ term: { team_id: params.team_id } }];
    if (params.status) filter.push({ term: { status: params.status } });
    if (params.side) filter.push({ term: { side: params.side } });
    const res = await this.client.search({
      index: this.opts.tasksIndex,
      size: params.limit,
      query: { bool: { filter } },
      sort: [{ created_at: "desc" }],
    });
    return res.hits.hits.map((h) => TaskDocSchema.parse(h._source));
  }

  async counts(team_id: string): Promise<StoreCounts> {
    const query: Query = { bool: { filter: [{ term: { team_id } }] } };
    const terms = (field: string) => ({ terms: { field, size: 50 } });
    const [raw, items] = await Promise.all([
      this.client.search({
        index: this.opts.rawIndex,
        size: 0,
        track_total_hits: true,
        query,
        aggs: { by_who: terms("who"), by_type: terms("type"), by_side: terms("side") },
      }),
      this.client.count({ index: this.opts.itemsIndex, query }),
    ]);
    const total = raw.hits.total;
    const bucketsOf = (name: string): Record<string, number> => {
      const agg = raw.aggregations?.[name] as estypes.AggregationsStringTermsAggregate | undefined;
      const buckets = Array.isArray(agg?.buckets) ? agg.buckets : [];
      return Object.fromEntries(buckets.map((b) => [String(b.key), b.doc_count]));
    };
    return {
      raw_total: typeof total === "number" ? total : (total?.value ?? 0),
      items_total: items.count,
      by_who: bucketsOf("by_who"),
      by_type: bucketsOf("by_type"),
      by_side: bucketsOf("by_side"),
    };
  }

  async ping(): Promise<boolean> {
    try {
      return await this.client.ping();
    } catch {
      return false;
    }
  }

  /** Create-only. There is deliberately no update or delete path for the raw index. */
  async indexRaw(docs: RawDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const index = this.opts.rawIndex;
    await withSpan("elastic.index_raw", { "es.index": index, "docs.count": docs.length }, async () => {
      const res = await this.client.bulk({
        refresh: "wait_for",
        operations: docs.flatMap((doc) => [{ create: { _index: index, _id: doc.id } }, doc]),
      });
      if (!res.errors) return;
      const failed = res.items.map((i) => i.create).filter((i) => i?.error);
      const conflict = failed.find((i) => i?.status === 409);
      if (conflict) throw new Error(`context_raw is immutable: ${conflict._id} already exists`);
      throw new Error(`indexRaw failed: ${failed[0]?.error?.reason ?? "unknown bulk error"}`);
    });
  }

  async indexItems(items: ItemDoc[]): Promise<void> {
    if (items.length === 0) return;
    const index = this.opts.itemsIndex;
    await withSpan("elastic.index_items", { "es.index": index, "docs.count": items.length }, async () => {
      const res = await this.client.bulk({
        refresh: "wait_for",
        operations: items.flatMap((item) => [{ index: { _index: index, _id: item.id } }, item]),
      });
      if (!res.errors) return;
      const failed = res.items.map((i) => i.index).find((i) => i?.error);
      throw new Error(`indexItems failed: ${failed?.error?.reason ?? "unknown bulk error"}`);
    });
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const indices = [this.opts.rawIndex, this.opts.itemsIndex];
    return withSpan("elastic.search", { "team.id": params.team_id }, async (span) => {
      const started = Date.now();
      let mode: SearchResponse["mode"] = "hybrid";
      let res: estypes.SearchResponse<unknown>;
      try {
        res = await this.client.search(buildHybridRequest(params, indices));
      } catch (err) {
        if (!warnedKeywordFallback) {
          warnedKeywordFallback = true;
          console.warn(
            `[elastic] hybrid search failed on ${indices.join(",")}; falling back to BM25 only: ${String(err)}`,
          );
        }
        mode = "keyword";
        res = await this.client.search(buildKeywordRequest(params, indices));
      }
      span.setAttribute("search.mode", mode);
      const hits = res.hits.hits.map((h): SearchHit => {
        const score = h._score ?? 0;
        if (h._index === this.opts.rawIndex) {
          return { layer: "raw", score, doc: RawDocSchema.parse(h._source), items: [] };
        }
        return { layer: "item", score, doc: ItemDocSchema.parse(h._source) };
      });
      await this.attachLinkedItems(params.team_id, hits);
      return { hits, took_ms: Date.now() - started, mode };
    });
  }

  /** One follow-up query: items whose provenance points at any returned raw chunk. */
  private async attachLinkedItems(team_id: string, hits: SearchHit[]): Promise<void> {
    const rawHits = hits.filter((h) => h.layer === "raw");
    if (rawHits.length === 0) return;
    const rawIds = rawHits.map((h) => h.doc.id);
    const res = await this.client.search({
      index: this.opts.itemsIndex,
      size: 100,
      query: { bool: { filter: [{ term: { team_id } }, { terms: { raw_ids: rawIds } }] } },
    });
    const linked = res.hits.hits.map((h) => ItemDocSchema.parse(h._source));
    for (const hit of rawHits) hit.items = linked.filter((i) => i.raw_ids.includes(hit.doc.id));
  }

  async recent(params: RecentParams): Promise<RawDoc[]> {
    const filter: Query[] = [{ term: { team_id: params.team_id } }];
    if (params.who) filter.push({ term: { who: params.who } });
    if (params.type) filter.push({ term: { type: params.type } });
    if (params.side) filter.push({ term: { side: params.side } });
    if (params.before) filter.push({ range: { at: { lt: params.before } } });
    const res = await this.client.search({
      index: this.opts.rawIndex,
      size: params.limit,
      query: { bool: { filter } },
      sort: [{ at: "desc" }, { seq: "desc" }],
    });
    return res.hits.hits.map((h) => RawDocSchema.parse(h._source));
  }

  async rawByIds(team_id: string, ids: string[]): Promise<RawDoc[]> {
    const unique = [...new Set(ids)].slice(0, MAX_RAW_BY_IDS);
    if (unique.length === 0) return [];
    const res = await this.client.search({
      index: this.opts.rawIndex,
      size: unique.length,
      query: { bool: { filter: [{ term: { team_id } }, { terms: { id: unique } }] } },
    });
    return res.hits.hits.map((h) => RawDocSchema.parse(h._source));
  }

  async items(params: ItemsParams): Promise<ItemDoc[]> {
    const filter: Query[] = [{ term: { team_id: params.team_id } }];
    if (params.kind) filter.push({ term: { kind: params.kind } });
    if (params.status) filter.push({ term: { status: params.status } });
    if (params.verdict) filter.push({ term: { verdict: params.verdict } });
    const res = await this.client.search({
      index: this.opts.itemsIndex,
      size: params.limit,
      query: { bool: { filter } },
      sort: [{ at: "desc" }],
    });
    return res.hits.hits.map((h) => ItemDocSchema.parse(h._source));
  }

  async itemById(team_id: string, id: string): Promise<ItemDoc | undefined> {
    const res = await this.client.search({
      index: this.opts.itemsIndex,
      size: 1,
      query: { bool: { filter: [{ term: { team_id } }, { term: { id } }] } },
    });
    const hit = res.hits.hits[0];
    return hit ? ItemDocSchema.parse(hit._source) : undefined;
  }
}
