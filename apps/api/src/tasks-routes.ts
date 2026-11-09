// Delegator + dashboard routes: claim/close/list tasks, and the stats the dashboard shows.
// The rules live in @hh/shared (claimTask/closeTask); this file only exposes them over HTTP.
import {
  type ApiError,
  type CaptureStatus,
  claimTask,
  closeTask,
  type ContextStore,
  type Dispatcher,
  ROUTES,
  type StatsResponse,
  TaskClaimRequestSchema,
  TaskCloseRequestSchema,
  type TaskDoc,
  TasksParamsSchema,
  type TasksResponse,
} from "@hh/shared";
import type { Context, Hono } from "hono";

export const SLO_TARGET_MS = 10_000;

// Structural so apps/api needs no direct zod dependency.
interface Schema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

const apiError = (error: string, detail?: unknown): ApiError =>
  detail === undefined ? { error } : { error, detail };

// biome-ignore lint/suspicious/noExplicitAny: any Hono env works; we only use c.json
type AnyContext = Context<any>;

function parse<T>(c: AnyContext, schema: Schema<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data };
  return { res: c.json(apiError("invalid request", result.error.issues), 400) };
}

async function readJson(c: AnyContext) {
  try {
    return { body: (await c.req.json()) as unknown };
  } catch (err) {
    return { res: c.json(apiError("body is not valid JSON", String(err)), 400) };
  }
}

/** Nearest-rank percentile over an ascending-sorted list. */
export function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** The SLO is "what someone said is searchable in under 10 s". Repo activity pulled in by the GitHub poller arrives in bursts and is not a person waiting, so it is not counted. */
const HUMAN_CAPTURE_TYPES = new Set(["voice", "text", "file"]);

export function sloFrom(all: CaptureStatus[]): StatsResponse["slo"] {
  const captures = all.filter((c) => HUMAN_CAPTURE_TYPES.has(c.type));
  const ms = captures
    .map((c) => c.ms_to_searchable)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const p50 = percentile(ms, 50);
  const p95 = percentile(ms, 95);
  return {
    target_ms: SLO_TARGET_MS,
    count: ms.length,
    ...(p50 === undefined ? {} : { p50_ms: p50 }),
    ...(p95 === undefined ? {} : { p95_ms: p95 }),
    failed: captures.filter((c) => c.state === "failed").length,
  };
}

export function registerTaskRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: shares the app's env without importing it
  app: Hono<any>,
  { store, dispatcher }: { store: ContextStore; dispatcher: Dispatcher },
) {
  /** Live feed + a searchable brain note. The brain write is best-effort: it never fails the request. */
  async function announce(task: TaskDoc, who: string, text: string) {
    dispatcher.publish(task.team_id, { event: "task", data: task });
    const now = new Date().toISOString();
    try {
      await dispatcher.dispatch({
        capture_id: crypto.randomUUID(),
        team_id: task.team_id,
        who,
        type: "text",
        side: task.side,
        at: now,
        received_at: now,
        source_ref: `task:${task.id}`,
        text,
      });
    } catch (err) {
      console.error(`task brain write failed team_id=${task.team_id} task=${task.id}:`, err);
    }
  }

  app.post(ROUTES.tasks, async (c) => {
    const json = await readJson(c);
    if (json.res) return json.res;
    const parsed = parse(c, TaskClaimRequestSchema, json.body);
    if (parsed.res) return parsed.res;
    const result = await claimTask(store, parsed.data);
    if (!result.ok) return c.json(result.conflict, 409);
    const { task } = result;
    await announce(
      task,
      task.owner,
      `[task claimed] ${task.title} — ${task.owner} is editing ${task.paths.join(", ")}`,
    );
    return c.json(task, 201);
  });

  app.post(ROUTES.taskClose, async (c) => {
    const json = await readJson(c);
    if (json.res) return json.res;
    const parsed = parse(c, TaskCloseRequestSchema, json.body);
    if (parsed.res) return parsed.res;
    const task = await closeTask(store, c.req.param("id"), parsed.data);
    if (!task) return c.json(apiError("task not found"), 404);
    const verb = task.status === "done" ? "done" : "released";
    const pr = task.pr ? ` (PR ${task.pr})` : "";
    await announce(
      task,
      parsed.data.who,
      `[task ${verb}] ${task.title} — ${task.owner} freed ${task.paths.join(", ")}${pr}`,
    );
    return c.json(task);
  });

  app.get(ROUTES.tasks, async (c) => {
    const parsed = parse(c, TasksParamsSchema, c.req.query());
    if (parsed.res) return parsed.res;
    const res: TasksResponse = { tasks: await store.tasks(parsed.data) };
    return c.json(res);
  });

  app.get(ROUTES.stats, async (c) => {
    const parsed = parse(c, TasksParamsSchema.pick({ team_id: true }), c.req.query());
    if (parsed.res) return parsed.res;
    const { team_id } = parsed.data;
    const [counts, open, captures] = await Promise.all([
      store.counts(team_id),
      store.tasks({ team_id, status: "claimed", limit: 200 }),
      dispatcher.captures(team_id),
    ]);
    const res: StatsResponse = { ...counts, open_tasks: open.length, slo: sloFrom(captures) };
    return c.json(res);
  });
}
