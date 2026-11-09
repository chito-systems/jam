// THE CONTRACT between streams (api, worker, mcp, web).
// Change this file only in its own small PR and tag both owners on the Board.
// Everything on the wire is one of these shapes. Times are UTC ISO strings.
import { z } from "zod";

// ---------- Routes (web + api share one origin; api lives under /api) ----------
export const ROUTES = {
  ingest: "/api/ingest", // POST json (IngestTextRequest) or multipart (IngestUploadFields + `file`)
  capture: "/api/captures/:id", // GET -> CaptureStatus
  search: "/api/search", // GET ?SearchParams -> SearchResponse
  recent: "/api/recent", // GET ?RecentParams -> RecentResponse
  items: "/api/items", // GET ?ItemsParams -> ItemsResponse
  events: "/api/events", // GET ?team_id= -> SSE stream of FeedEvent
  mcp: "/mcp", // MCP streamable HTTP: /mcp?team_id=<code>&who=<agent name>
  healthz: "/healthz",
  readyz: "/readyz",
} as const;

// ---------- Enums ----------
export const SourceTypeSchema = z.enum(["voice", "text", "file", "board", "pr", "review"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const ItemKindSchema = z.enum([
  "decision",
  "question",
  "todo",
  "person",
  "idea",
  "blocker",
  "fact",
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ItemStatusSchema = z.enum(["open", "done", "superseded"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const CaptureStateSchema = z.enum([
  "queued",
  "transcribing",
  "indexing",
  "indexed",
  "failed",
]);
export type CaptureState = z.infer<typeof CaptureStateSchema>;

const IsoUtcSchema = z.iso.datetime(); // "2026-11-09T19:04:05.123Z" — UTC only
const TeamIdSchema = z.string().min(1).max(64);
const WhoSchema = z.string().min(1).max(64); // cam | jake | gitar | agent:opus-1 ...

// ---------- Documents ----------
/** Index `context_raw`. The truth. Immutable: created once, never updated or deleted. */
export const RawDocSchema = z.object({
  team_id: TeamIdSchema,
  id: z.string(), // `${capture_id}:${seq}`
  capture_id: z.string(), // one recording / paste / board post = one capture, many chunks
  type: SourceTypeSchema,
  who: WhoSchema,
  at: IsoUtcSchema, // when it was said (chunk start), not when it was indexed
  source_ref: z.string().optional(), // file name, issue comment url, PR number
  seq: z.number().int().nonnegative(), // chunk order within the capture
  text: z.string().min(1),
  duration_s: z.number().nonnegative().optional(),
});
export type RawDoc = z.infer<typeof RawDocSchema>;

/** Index `context_items`. The librarian's structured layer. Allowed to be wrong; links back to raw. */
export const ItemDocSchema = z.object({
  team_id: TeamIdSchema,
  id: z.string(),
  kind: ItemKindSchema,
  text: z.string().min(1), // one clean sentence
  who: WhoSchema,
  at: IsoUtcSchema,
  tags: z.array(z.string()).default([]),
  raw_ids: z.array(z.string()).default([]), // provenance: which raw chunks this came from
  status: ItemStatusSchema.default("open"),
});
export type ItemDoc = z.infer<typeof ItemDocSchema>;

// ---------- Ingest ----------
/** POST /api/ingest with content-type application/json. */
export const IngestTextRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  type: SourceTypeSchema.default("text"),
  text: z.string().min(1),
  source_ref: z.string().optional(),
  at: IsoUtcSchema.optional(), // defaults to server receive time
});
export type IngestTextRequest = z.infer<typeof IngestTextRequestSchema>;

/** POST /api/ingest with multipart/form-data: these fields plus a `file` part (audio or text file). */
export const IngestUploadFieldsSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  type: SourceTypeSchema.default("voice"),
  source_ref: z.string().optional(),
  at: IsoUtcSchema.optional(), // when recording STARTED; chunk times are offsets from this
});
export type IngestUploadFields = z.infer<typeof IngestUploadFieldsSchema>;

/** 202 from POST /api/ingest. Poll ROUTES.capture or watch SSE for progress. */
export const IngestResponseSchema = z.object({
  capture_id: z.string(),
  state: CaptureStateSchema,
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

/** GET /api/captures/:id. `ms_to_searchable` is the product's SLO number (target < 10 000). */
export const CaptureStatusSchema = z.object({
  capture_id: z.string(),
  team_id: TeamIdSchema,
  who: WhoSchema,
  type: SourceTypeSchema,
  state: CaptureStateSchema,
  received_at: IsoUtcSchema,
  searchable_at: IsoUtcSchema.optional(),
  ms_to_searchable: z.number().optional(),
  raw_ids: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;

// ---------- Read ----------
export const SearchParamsSchema = z.object({
  team_id: TeamIdSchema,
  q: z.string().min(1),
  who: WhoSchema.optional(),
  type: SourceTypeSchema.optional(),
  since: IsoUtcSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export const SearchHitSchema = z.discriminatedUnion("layer", [
  // A raw chunk, plus any librarian items derived from it.
  z.object({
    layer: z.literal("raw"),
    score: z.number(),
    doc: RawDocSchema,
    items: z.array(ItemDocSchema).default([]),
  }),
  z.object({ layer: z.literal("item"), score: z.number(), doc: ItemDocSchema }),
]);
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  hits: z.array(SearchHitSchema),
  took_ms: z.number(),
  mode: z.enum(["hybrid", "keyword"]), // "keyword" = in-memory dev store, no vectors
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const RecentParamsSchema = z.object({
  team_id: TeamIdSchema,
  limit: z.coerce.number().int().min(1).max(200).default(20),
  before: IsoUtcSchema.optional(), // pagination cursor: docs strictly older than this
  who: WhoSchema.optional(),
  type: SourceTypeSchema.optional(),
});
export type RecentParams = z.infer<typeof RecentParamsSchema>;

/** Newest first. */
export const RecentResponseSchema = z.object({ docs: z.array(RawDocSchema) });
export type RecentResponse = z.infer<typeof RecentResponseSchema>;

export const ItemsParamsSchema = z.object({
  team_id: TeamIdSchema,
  kind: ItemKindSchema.optional(),
  status: ItemStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ItemsParams = z.infer<typeof ItemsParamsSchema>;

/** Newest first. Empty until the librarian lands. */
export const ItemsResponseSchema = z.object({ items: z.array(ItemDocSchema) });
export type ItemsResponse = z.infer<typeof ItemsResponseSchema>;

// ---------- Live feed (SSE on ROUTES.events) ----------
// Each SSE message has `event: <name>` and `data: <json>`.
export type FeedEvent =
  | { event: "raw"; data: RawDoc } // a chunk just became searchable
  | { event: "item"; data: ItemDoc } // the librarian extracted or updated something
  | { event: "capture"; data: CaptureStatus }; // a capture changed state

/** Every non-2xx JSON response. */
export const ApiErrorSchema = z.object({ error: z.string(), detail: z.unknown().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
