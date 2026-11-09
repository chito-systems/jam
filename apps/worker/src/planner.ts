// jam, the planner: turns a captured todo into a work order a coding agent can execute.
// One LLM call drafts the parts; the markdown is rendered here so quotes stay verbatim and the shape never drifts.
import { type ItemDoc, normalizePath, type RawDoc, SIDE_PATHS, withSpan } from "@hh/shared";
import { DEFAULT_LIBRARIAN_MODEL } from "./librarian";

type FetchImpl = typeof fetch;

export interface PlannerInput {
  todo: ItemDoc;
  /** The raw chunks the todo came from. */
  quotes: RawDoc[];
  /** Existing decisions that are not rejected, newest first: constraints the work must respect. */
  decisions: ItemDoc[];
}

export interface WorkOrderDraft {
  title: string;
  paths: string[];
  spec: string;
}

export interface Planner {
  readonly name: string;
  draft(input: PlannerInput): Promise<WorkOrderDraft>;
}

export const MAX_PATHS = 6;
const MAX_TITLE = 80;
const MAX_DECISIONS = 15;
const MAX_QUOTE = 280;
const TIMEOUT_MS = 60_000;
const VENUE_TZ = "America/Denver";
export const PR_RULE =
  "One PR, under 300 lines, with tests. Call `task_claim` on the paths before editing and `task_done` when the PR is open.";

const sidesTable = Object.entries(SIDE_PATHS)
  .map(([side, prefixes]) => `- ${side}: ${prefixes.join(", ")}`)
  .join("\n");

export const REPO_MAP = `Repo map (pnpm monorepo, TypeScript):
${sidesTable}
- API routes: apps/api/src/*-routes.ts (Hono), wired in apps/api/src/app.ts
- Ingest pipeline, librarian, dispatcher: apps/worker/src
- The contract between streams: packages/shared/src/types.ts
- MCP tools for agents: packages/mcp/src/index.ts
- Web UI (React + Vite): apps/web/src`;

export const SYSTEM_PROMPT = `You are jam, the planner for a hackathon team that builds software with humans and coding agents. You turn one todo the team said out loud into a work order a coding agent can pick up and finish without asking questions.

You get: the todo, the verbatim transcript chunks it came from (id, who, when), the team's existing decisions, and a map of the repo.

Return:
- title: an imperative instruction, at most 80 characters ("Add confirm and reject buttons to the decision list").
- goal: one or two plain sentences: what will be true when this is done, and for whom.
- quotes: 1 to 2 entries, each a raw_id from the chunks and an excerpt copied character for character from that chunk's text: the words that ask for this work. Shorten to the relevant sentence; never paraphrase.
- acceptance_criteria: 3 to 5 outcomes a reviewer can check by looking at the app, the API or the tests. Concrete and observable; no "works well", no "is robust", no filler like "nothing else changes" or restating another criterion. Three sharp criteria beat five padded ones.
- decision_ids: ids of existing decisions this work must respect. Only ones that genuinely constrain this todo; usually none or one.
- software: true if this is a change to the repo, false for anything else (errands, conversations, logistics).
- paths: 0 to 6 repo-relative files or directories you expect to change, chosen from the repo map. Prefer a directory (apps/web/src) over a guessed file name; name a file only when the map names it. Empty when software is false or you genuinely cannot tell. Only paths that must change: if the team says something already exists ("the route is already there"), leave its files out. Whoever accepts the order can only edit their own side's paths, so stay on one side unless the work truly needs both.

Rules:
- Use only facts from the todo, the quotes and the decisions. Do not invent requirements, endpoints, field names, owners or deadlines. If the team did not say how, describe the outcome, not an implementation.
- Who should do the work is decided elsewhere: never mention an assignee in the title, goal or criteria.
- If the todo is not software work ("get lunch", "talk to the Radar table"), still write the goal and criteria plainly, set software to false and return no paths.
- Plain words. No marketing language.`;

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "work_order",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "goal", "quotes", "acceptance_criteria", "decision_ids", "software", "paths"],
      properties: {
        title: { type: "string" },
        goal: { type: "string" },
        quotes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["raw_id", "excerpt"],
            properties: { raw_id: { type: "string" }, excerpt: { type: "string" } },
          },
        },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        decision_ids: { type: "array", items: { type: "string" } },
        software: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

/** What the model returns, before rendering. */
export interface ModelWorkOrder {
  title: string;
  goal: string;
  quotes: { raw_id: string; excerpt: string }[];
  acceptance_criteria: string[];
  decision_ids: string[];
  software: boolean;
  paths: string[];
}

export function buildUserMessage(input: PlannerInput): string {
  const todo = { id: input.todo.id, text: input.todo.text, who: input.todo.who, at: input.todo.at };
  const chunks = input.quotes.map((q) => ({ id: q.id, who: q.who, at: q.at, text: q.text }));
  const decisions = input.decisions.slice(0, MAX_DECISIONS).map((d) => ({ id: d.id, text: d.text }));
  return `${REPO_MAP}\n\nExisting decisions (newest first):\n${JSON.stringify(decisions)}\n\nTodo:\n${JSON.stringify(todo)}\n\nTranscript chunks it came from:\n${JSON.stringify(chunks)}`;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Parses the model's JSON content. Throws a clear error on anything malformed. */
export function parseModelOutput(content: string): ModelWorkOrder {
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    throw new Error(`planner: model returned invalid JSON: ${content.slice(0, 200)}`);
  }
  const o = body as Partial<ModelWorkOrder> | null;
  const ok =
    o &&
    typeof o.title === "string" &&
    o.title.trim() !== "" &&
    typeof o.goal === "string" &&
    Array.isArray(o.quotes) &&
    o.quotes.every((q) => q && typeof q.raw_id === "string" && typeof q.excerpt === "string") &&
    isStringArray(o.acceptance_criteria) &&
    isStringArray(o.decision_ids) &&
    typeof o.software === "boolean" &&
    isStringArray(o.paths);
  if (!ok) throw new Error(`planner: malformed work order: ${content.slice(0, 200)}`);
  return o as ModelWorkOrder;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const oneLine = (s: string) => squash(s).replace(/^[-*]\s*(\[[ x]\]\s*)?/i, "");

function clip(s: string, max: number): string {
  const t = squash(s);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "1:04 PM MT", in the venue's time zone. */
function venueTime(iso: string): string {
  const t = new Date(iso).toLocaleTimeString("en-US", { timeZone: VENUE_TZ, hour: "numeric", minute: "2-digit" });
  return `${t} MT`;
}

/** Top-level names a path may start with: the side prefixes plus repo-root files. */
const ROOTS = new Set(Object.values(SIDE_PATHS).flatMap((ps) => ps.map((p) => normalizePath(p).split("/")[0])));

/** Repo-relative, inside known territory, no traversal, deduped, at most 6. */
export function cleanPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = normalizePath(raw);
    if (!p || p.includes("..") || p.startsWith("/") || /\s/.test(p)) continue;
    const top = p.split("/")[0] ?? "";
    const rootFile = !p.includes("/") && p.includes(".");
    if (!ROOTS.has(top) && !rootFile && !top.startsWith("Dockerfile")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, MAX_PATHS);
}

/** Renders the work order. Quotes are checked against the chunks: a paraphrase falls back to the chunk itself. */
export function renderWorkOrder(m: ModelWorkOrder, input: PlannerInput): WorkOrderDraft {
  const chunks = new Map(input.quotes.map((q) => [q.id, q]));
  const picked: { chunk: RawDoc; text: string }[] = [];
  for (const q of m.quotes) {
    const chunk = chunks.get(q.raw_id);
    if (!chunk || picked.length >= 2 || picked.some((p) => p.chunk.id === chunk.id)) continue;
    const excerpt = squash(q.excerpt);
    picked.push({ chunk, text: excerpt && squash(chunk.text).includes(excerpt) ? excerpt : chunk.text });
  }
  picked.sort((a, b) => a.chunk.at.localeCompare(b.chunk.at) || a.chunk.seq - b.chunk.seq); // as it was said
  const quoteLines = picked.map(
    ({ chunk, text }) => `> "${clip(text, MAX_QUOTE)}" — ${chunk.who}, ${venueTime(chunk.at)} (\`${chunk.id}\`)`,
  );
  if (quoteLines.length === 0) {
    for (const chunk of input.quotes.slice(0, 2)) {
      quoteLines.push(`> "${clip(chunk.text, MAX_QUOTE)}" — ${chunk.who}, ${venueTime(chunk.at)} (\`${chunk.id}\`)`);
    }
  }
  if (quoteLines.length === 0) quoteLines.push(`> "${clip(input.todo.text, MAX_QUOTE)}" — ${input.todo.who} (librarian summary)`);

  const decisions = new Map(input.decisions.map((d) => [d.id, d]));
  const constraints = [...new Set(m.decision_ids)].flatMap((id) => {
    const d = decisions.get(id);
    return d ? [`- ${squash(d.text)}`] : [];
  });
  if (m.software) constraints.push(`- ${PR_RULE}`);

  const criteria = m.acceptance_criteria.map(oneLine).filter(Boolean).slice(0, 5);
  const spec = [
    "## Goal",
    squash(m.goal) || squash(input.todo.text),
    "",
    "## Why (from the team's own words)",
    quoteLines.join("\n\n"),
    "",
    "## Acceptance criteria",
    (criteria.length > 0 ? criteria : [squash(input.todo.text)]).map((c) => `- [ ] ${c}`).join("\n"),
    ...(constraints.length > 0 ? ["", "## Constraints", constraints.join("\n")] : []),
  ].join("\n");

  return {
    title: clip(m.title.replace(/[.\s]+$/, ""), MAX_TITLE),
    paths: m.software ? cleanPaths(m.paths) : [],
    spec,
  };
}

export interface OpenAIPlannerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

export class OpenAIPlanner implements Planner {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OpenAIPlannerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_LIBRARIAN_MODEL;
    this.baseUrl = (opts.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = `openai:${this.model}`;
  }

  draft(input: PlannerInput): Promise<WorkOrderDraft> {
    const attrs = { team_id: input.todo.team_id, item_id: input.todo.id, model: this.model };
    return withSpan("planner.draft", attrs, async (span) => {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserMessage(input) },
          ],
          response_format: RESPONSE_FORMAT,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`OpenAI planner failed: ${res.status} ${res.statusText} ${body}`.trim());
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }> };
      const message = body.choices?.[0]?.message;
      if (message?.refusal) throw new Error(`planner: model refused: ${message.refusal.slice(0, 200)}`);
      if (typeof message?.content !== "string") throw new Error("planner: response has no message content");
      const draft = renderWorkOrder(parseModelOutput(message.content), input);
      span.setAttribute("paths", draft.paths.length);
      return draft;
    });
  }
}

/** An OpenAIPlanner when OPENAI_API_KEY is set and PLANNER isn't "off"; otherwise undefined. */
export function createPlannerFromEnv(env: NodeJS.ProcessEnv): Planner | undefined {
  if ((env.PLANNER || "on").trim().toLowerCase() === "off") return undefined;
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAIPlanner({
    apiKey,
    model: env.PLANNER_MODEL?.trim() || undefined,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
  });
}
