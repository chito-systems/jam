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
  tasks: "/api/tasks", // GET ?TasksParams -> TasksResponse · POST TaskClaimRequest -> 201 TaskDoc | 409 TaskConflict
  taskClose: "/api/tasks/:id/close", // POST TaskCloseRequest -> TaskDoc (also how a proposed work order is dismissed: status "released")
  taskAccept: "/api/tasks/:id/accept", // POST TaskAcceptRequest -> 200 TaskDoc (now claimed) | 409 TaskConflict
  stats: "/api/stats", // GET ?team_id= -> StatsResponse (the dashboard's numbers)
  itemVerdict: "/api/items/:id/verdict", // POST ItemVerdictRequest -> ItemDoc (a human confirms or rejects what the librarian extracted)
  chaos: "/api/chaos", // GET -> ChaosState · POST ChaosRequest -> ChaosState (demo switch: slows and fails the index step)
  decisionsMd: "/api/decisions.md", // GET ?team_id= -> text/markdown: the decision log, each entry quoting the raw chunks it came from
  mcp: "/mcp", // MCP streamable HTTP: /mcp?team_id=<code>&who=<agent name>&side=<backend|frontend>
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

/** Which half of the team something belongs to. Tags captures, scopes agents, owns paths. */
export const SideSchema = z.enum(["backend", "frontend"]);
export type Side = z.infer<typeof SideSchema>;

/**
 * Path ownership per side: the delegator refuses a claim outside the claimer's side.
 * Mirrors the table in AGENTS.md. Prefix match on repo-relative paths.
 */
export const SIDE_PATHS: Record<Side, readonly string[]> = {
  backend: [
    "apps/api/",
    "apps/worker/",
    "packages/",
    "deploy/",
    "argocd/",
    "scripts/",
    ".github/",
    "Dockerfile",
  ],
  frontend: ["apps/web/"],
};

// proposed: jam drafted it from something the team said; nobody has taken it and it locks no paths.
// claimed: someone is editing those paths now. done / released: finished or dropped; paths are free.
export const TaskStatusSchema = z.enum(["proposed", "claimed", "done", "released"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ItemVerdictSchema = z.enum(["confirmed", "rejected"]);
export type ItemVerdict = z.infer<typeof ItemVerdictSchema>;

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
  side: SideSchema.optional(), // who it came from: backend or frontend half of the team
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
  // Grading. The librarian scores itself; a human has the last word.
  confidence: z.number().min(0).max(1).optional(), // librarian's own 0..1: how directly the quoted words support this item
  verdict: ItemVerdictSchema.optional(), // set by a person: confirmed = "yes, we said that"; rejected = "no"
  verified_by: WhoSchema.optional(),
  verified_at: IsoUtcSchema.optional(),
});
export type ItemDoc = z.infer<typeof ItemDocSchema>;

/** POST /api/items/:id/verdict. Rejected items stay stored (and visible as rejected) but leave the decision log. */
export const ItemVerdictRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  verdict: ItemVerdictSchema,
});
export type ItemVerdictRequest = z.infer<typeof ItemVerdictRequestSchema>;

// ---------- Ingest ----------
/** POST /api/ingest with content-type application/json. */
export const IngestTextRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  type: SourceTypeSchema.default("text"),
  text: z.string().min(1),
  source_ref: z.string().optional(),
  side: SideSchema.optional(),
  at: IsoUtcSchema.optional(), // defaults to server receive time
});
export type IngestTextRequest = z.infer<typeof IngestTextRequestSchema>;

/** POST /api/ingest with multipart/form-data: these fields plus a `file` part (audio or text file). */
export const IngestUploadFieldsSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  type: SourceTypeSchema.default("voice"),
  source_ref: z.string().optional(),
  side: SideSchema.optional(),
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
  side: SideSchema.optional(),
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
  mode: z.enum(["hybrid", "keyword"]), // "keyword" = no vectors: the in-memory dev store, or Elastic fell back
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const RecentParamsSchema = z.object({
  team_id: TeamIdSchema,
  limit: z.coerce.number().int().min(1).max(200).default(20),
  before: IsoUtcSchema.optional(), // pagination cursor: docs strictly older than this
  who: WhoSchema.optional(),
  type: SourceTypeSchema.optional(),
  side: SideSchema.optional(),
});
export type RecentParams = z.infer<typeof RecentParamsSchema>;

/** Newest first. */
export const RecentResponseSchema = z.object({ docs: z.array(RawDocSchema) });
export type RecentResponse = z.infer<typeof RecentResponseSchema>;

export const ItemsParamsSchema = z.object({
  team_id: TeamIdSchema,
  kind: ItemKindSchema.optional(),
  status: ItemStatusSchema.optional(),
  verdict: ItemVerdictSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ItemsParams = z.infer<typeof ItemsParamsSchema>;

/** Newest first. Empty until the librarian lands. */
export const ItemsResponseSchema = z.object({ items: z.array(ItemDocSchema) });
export type ItemsResponse = z.infer<typeof ItemsResponseSchema>;

// ---------- Delegation: task claims ----------
/**
 * Index `context_tasks`. A claim says "this agent is editing these paths right now".
 * Mutable (unlike raw): status moves claimed -> done | released.
 */
export const TaskDocSchema = z.object({
  team_id: TeamIdSchema,
  id: z.string(),
  title: z.string().min(1).max(200),
  side: SideSchema,
  owner: WhoSchema, // who claimed it: cam-fable, agent:opus-3 ...
  paths: z.array(z.string().min(1)).max(20), // repo-relative files or directory prefixes; may be empty while proposed
  status: TaskStatusSchema,
  // Work orders: a task that jam drafted from a captured todo, waiting for a person to accept it.
  spec: z.string().optional(), // markdown build prompt, ready to hand to a coding agent: goal, context quotes, acceptance criteria
  item_id: z.string().optional(), // the todo/decision item it came from
  raw_ids: z.array(z.string()).optional(), // the transcript chunks behind it
  proposed_by: WhoSchema.optional(), // "jam" for drafted work orders; absent for direct claims
  suggested_owner: WhoSchema.optional(), // who jam thinks should take it
  reason: z.string().optional(), // which assignment rule picked the side/owner, in one sentence
  pr: z.string().optional(), // PR number or url once there is one
  note: z.string().optional(),
  created_at: IsoUtcSchema,
  updated_at: IsoUtcSchema,
});
export type TaskDoc = z.infer<typeof TaskDocSchema>;

/** POST /api/tasks. 201 TaskDoc, or 409 TaskConflict. */
export const TaskClaimRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  side: SideSchema,
  title: z.string().min(1).max(200),
  paths: z.array(z.string().min(1)).min(1).max(20),
});
export type TaskClaimRequest = z.infer<typeof TaskClaimRequestSchema>;

/**
 * POST /api/tasks/:id/accept. A person (or an agent told to by one) takes a proposed work order.
 * It becomes a normal claim: same ownership and overlap checks, 409 TaskConflict if they fail.
 */
export const TaskAcceptRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  side: SideSchema.optional(), // defaults to the side jam proposed
  paths: z.array(z.string().min(1)).min(1).max(20).optional(), // defaults to the paths jam proposed
});
export type TaskAcceptRequest = z.infer<typeof TaskAcceptRequestSchema>;

/** 409 from a claim. `overlap`: another open claim holds a path. `wrong_side`: a path belongs to the other side. */
export const TaskConflictSchema = z.object({
  error: z.string(),
  reason: z.enum(["overlap", "wrong_side"]),
  offending_paths: z.array(z.string()),
  conflicts: z.array(TaskDocSchema), // the open claims in the way (empty for wrong_side)
});
export type TaskConflict = z.infer<typeof TaskConflictSchema>;

/** POST /api/tasks/:id/close. */
export const TaskCloseRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  status: z.enum(["done", "released"]).default("done"),
  pr: z.string().optional(),
  note: z.string().optional(),
});
export type TaskCloseRequest = z.infer<typeof TaskCloseRequestSchema>;

export const TasksParamsSchema = z.object({
  team_id: TeamIdSchema,
  status: TaskStatusSchema.optional(),
  side: SideSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TasksParams = z.infer<typeof TasksParamsSchema>;

/** Newest first. */
export const TasksResponseSchema = z.object({ tasks: z.array(TaskDocSchema) });
export type TasksResponse = z.infer<typeof TasksResponseSchema>;

// ---------- Chaos (the demo's failure switch) ----------
/**
 * When enabled, the worker's index step waits 3 s and fails 20% of the time.
 * Off by default. The UI must show a visible CHAOS label whenever `enabled` is true.
 */
export const ChaosStateSchema = z.object({
  enabled: z.boolean(),
  changed_at: IsoUtcSchema.optional(),
  changed_by: WhoSchema.optional(),
});
export type ChaosState = z.infer<typeof ChaosStateSchema>;

export const ChaosRequestSchema = z.object({
  team_id: TeamIdSchema,
  who: WhoSchema,
  enabled: z.boolean(),
});
export type ChaosRequest = z.infer<typeof ChaosRequestSchema>;

// ---------- Dashboard ----------
const CountsSchema = z.record(z.string(), z.number());

/** GET /api/stats. Everything the dashboard shows, in one call. */
export const StatsResponseSchema = z.object({
  raw_total: z.number(),
  items_total: z.number(),
  by_who: CountsSchema,
  by_type: CountsSchema,
  by_side: CountsSchema,
  open_tasks: z.number(),
  chaos: z.boolean().optional(), // true while the chaos switch is on
  // Time from "API received it" to "searchable", over this process's recent captures.
  slo: z.object({
    target_ms: z.number(),
    count: z.number(),
    p50_ms: z.number().optional(),
    p95_ms: z.number().optional(),
    failed: z.number(),
  }),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

// ---------- Live feed (SSE on ROUTES.events) ----------
// Each SSE message has `event: <name>` and `data: <json>`.
export type FeedEvent =
  | { event: "raw"; data: RawDoc } // a chunk just became searchable
  | { event: "item"; data: ItemDoc } // the librarian extracted or updated something
  | { event: "capture"; data: CaptureStatus } // a capture changed state
  | { event: "task"; data: TaskDoc } // a task was claimed, finished or released
  | { event: "chaos"; data: ChaosState }; // someone flipped the chaos switch

/** Every non-2xx JSON response. */
export const ApiErrorSchema = z.object({ error: z.string(), detail: z.unknown().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
