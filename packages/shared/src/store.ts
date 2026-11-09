// The data-layer seam. Everything that reads or writes context goes through ContextStore.
// Production: ElasticStore (Elasticsearch is the core data layer).
// Tests and no-credentials local dev: MemoryStore (keyword only, lost on restart, never deployed).
import type {
  ItemDoc,
  ItemsParams,
  RawDoc,
  RecentParams,
  SearchHit,
  SearchParams,
  SearchResponse,
} from "./types";

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
  /** Newest first. */
  items(params: ItemsParams): Promise<ItemDoc[]>;
  /** Cheap liveness check for /readyz. */
  ping(): Promise<boolean>;
}

const byNewest = (a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);

export class MemoryStore implements ContextStore {
  private raw = new Map<string, RawDoc>();
  private itemDocs = new Map<string, ItemDoc>();

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
      const s = score(doc.text);
      if (s === 0) continue;
      const items = [...this.itemDocs.values()].filter((i) => i.raw_ids.includes(doc.id));
      hits.push({ layer: "raw", score: s, doc, items });
    }
    if (!params.type) {
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
          (!params.before || d.at < params.before),
      )
      .sort((a, b) => byNewest(a, b) || b.seq - a.seq)
      .slice(0, params.limit);
  }

  async items(params: ItemsParams): Promise<ItemDoc[]> {
    return [...this.itemDocs.values()]
      .filter(
        (i) =>
          i.team_id === params.team_id &&
          (!params.kind || i.kind === params.kind) &&
          (!params.status || i.status === params.status),
      )
      .sort(byNewest)
      .slice(0, params.limit);
  }
}
