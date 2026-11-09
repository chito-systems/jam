// The data-layer seam. Everything that reads or writes context goes through ContextStore.
// Production: ElasticStore (Elasticsearch is the core data layer).
// Tests and no-credentials local dev: MemoryStore (keyword only, lost on restart, never deployed).
import type {
  ItemDoc,
  ItemsParams,
  ItemVerdict,
  RawDoc,
  RecentParams,
  SearchHit,
  SearchParams,
  SearchResponse,
  TaskDoc,
  TasksParams,
} from "./types";

/** Totals for the dashboard. Counts are over raw docs. */
export interface StoreCounts {
  raw_total: number;
  items_total: number;
  by_who: Record<string, number>;
  by_type: Record<string, number>;
  by_side: Record<string, number>;
}

export interface ContextStore {
  /** Create indices/mappings if missing. Idempotent. */
  ensureReady(): Promise<void>;
  /** Create-only. Must reject an id that already exists: raw docs are immutable. Searchable when it resolves. */
  indexRaw(docs: RawDoc[]): Promise<void>;
  /** Upsert by id (the librarian may supersede its own items). */
  indexItems(items: ItemDoc[]): Promise<void>;
  search(params: SearchParams): Promise<SearchResponse>;
  /** Newest first. */
  recent(params: RecentParams): Promise<RawDoc[]>;
  /** Raw chunks by id within one team (provenance lookups). Missing ids are skipped; order is not guaranteed. */
  rawByIds(team_id: string, ids: string[]): Promise<RawDoc[]>;
  /** Newest first. */
  items(params: ItemsParams): Promise<ItemDoc[]>;
  /** One item by id within one team, or undefined. */
  itemById(team_id: string, id: string): Promise<ItemDoc | undefined>;
  /** Create or replace a task claim by id. Tasks are mutable; raw docs are not. */
  upsertTask(task: TaskDoc): Promise<void>;
  /** Newest first. */
  tasks(params: TasksParams): Promise<TaskDoc[]>;
  counts(team_id: string): Promise<StoreCounts>;
  /** Cheap liveness check for /readyz. */
  ping(): Promise<boolean>;
}

/**
 * A person's verdict on one item: sets verdict/verified_by/verified_at and upserts it.
 * Idempotent; a different verdict overwrites. Undefined when the team has no such item.
 * Shared by the HTTP route and the MCP tool so both do exactly the same update.
 */
export async function setItemVerdict(
  store: ContextStore,
  req: { team_id: string; id: string; who: string; verdict: ItemVerdict },
  now: () => Date = () => new Date(),
): Promise<ItemDoc | undefined> {
  const existing = await store.itemById(req.team_id, req.id);
  if (!existing) return undefined;
  const item: ItemDoc = {
    ...existing,
    verdict: req.verdict,
    verified_by: req.who,
    verified_at: now().toISOString(),
  };
  await store.indexItems([item]);
  return item;
}

const byNewest =(a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);

export class MemoryStore implements ContextStore {
  private raw = new Map<string, RawDoc>();
  private itemDocs = new Map<string, ItemDoc>();
  private taskDocs = new Map<string, TaskDoc>();

  async ensureReady(): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  async indexRaw(docs: RawDoc[]): Promise<void> {
    for (const doc of docs) {
      if (this.raw.has(doc.id)) throw new Error(`context_raw is immutable: ${doc.id} already exists`);
    }
    for (const doc of docs) this.raw.set(doc.id, doc);
  }

  async indexItems(items: ItemDoc[]): Promise<void> {
    for (const item of items) this.itemDocs.set(item.id, item);
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const started = Date.now();
    const terms = params.q.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (text: string) => {
      const lower = text.toLowerCase();
      return terms.filter((t) => lower.includes(t)).length / terms.length;
    };
    const inScope = (d: { team_id: string; who: string; at: string }) =>
      d.team_id === params.team_id &&
      (!params.who || d.who === params.who) &&
      (!params.since || d.at >= params.since);

    const hits: SearchHit[] = [];
    for (const doc of this.raw.values()) {
      if (!inScope(doc) || (params.type && doc.type !== params.type)) continue;
      if (params.side && doc.side !== params.side) continue;
      const s = score(doc.text);
      if (s === 0) continue;
      const items = [...this.itemDocs.values()].filter((i) => i.raw_ids.includes(doc.id));
      hits.push({ layer: "raw", score: s, doc, items });
    }
    if (!params.type && !params.side) {
      for (const doc of this.itemDocs.values()) {
        if (!inScope(doc)) continue;
        const s = score(doc.text);
        if (s > 0) hits.push({ layer: "item", score: s, doc });
      }
    }
    hits.sort((a, b) => b.score - a.score || byNewest(a.doc, b.doc));
    return { hits: hits.slice(0, params.limit), took_ms: Date.now() - started, mode: "keyword" };
  }

  async recent(params: RecentParams): Promise<RawDoc[]> {
    return [...this.raw.values()]
      .filter(
        (d) =>
          d.team_id === params.team_id &&
          (!params.who || d.who === params.who) &&
          (!params.type || d.type === params.type) &&
          (!params.side || d.side === params.side) &&
          (!params.before || d.at < params.before),
      )
      .sort((a, b) => byNewest(a, b) || b.seq - a.seq)
      .slice(0, params.limit);
  }

  async rawByIds(team_id: string, ids: string[]): Promise<RawDoc[]> {
    return ids.flatMap((id) => {
      const doc = this.raw.get(id);
      return doc && doc.team_id === team_id ? [doc] : [];
    });
  }

  async items(params: ItemsParams): Promise<ItemDoc[]> {
    return [...this.itemDocs.values()]
      .filter(
        (i) =>
          i.team_id === params.team_id &&
          (!params.kind || i.kind === params.kind) &&
          (!params.status || i.status === params.status) &&
          (!params.verdict || i.verdict === params.verdict),
      )
      .sort(byNewest)
      .slice(0, params.limit);
  }

  async itemById(team_id: string, id: string): Promise<ItemDoc | undefined> {
    const item = this.itemDocs.get(id);
    return item && item.team_id === team_id ? item : undefined;
  }

  async upsertTask(task: TaskDoc): Promise<void> {
    this.taskDocs.set(task.id, task);
  }

  async tasks(params: TasksParams): Promise<TaskDoc[]> {
    return [...this.taskDocs.values()]
      .filter(
        (t) =>
          t.team_id === params.team_id &&
          (!params.status || t.status === params.status) &&
          (!params.side || t.side === params.side),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, params.limit);
  }

  async counts(team_id: string): Promise<StoreCounts> {
    const tally = (keys: (string | undefined)[]) => {
      const out: Record<string, number> = {};
      for (const k of keys) if (k) out[k] = (out[k] ?? 0) + 1;
      return out;
    };
    const raw = [...this.raw.values()].filter((d) => d.team_id === team_id);
    return {
      raw_total: raw.length,
      items_total: [...this.itemDocs.values()].filter((i) => i.team_id === team_id).length,
      by_who: tally(raw.map((d) => d.who)),
      by_type: tally(raw.map((d) => d.type)),
      by_side: tally(raw.map((d) => d.side)),
    };
  }
}
