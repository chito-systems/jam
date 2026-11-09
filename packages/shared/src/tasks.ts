// The delegator's rules. A claim says "this agent is editing these paths".
// A claim is refused if a path belongs to the other side, or overlaps an open claim.
// Pure logic over ContextStore, shared by the HTTP API and the MCP tools.
import type { ContextStore } from "./store";
import {
  SIDE_PATHS,
  type Side,
  type TaskAcceptRequest,
  type TaskClaimRequest,
  type TaskCloseRequest,
  type TaskConflict,
  type TaskDoc,
} from "./types";

export type ClaimResult = { ok: true; task: TaskDoc } | { ok: false; conflict: TaskConflict };
export type AcceptResult = ClaimResult | { ok: false; notFound: true } | { ok: false; error: string };

/** "./apps/api/src/**" -> "apps/api/src". Files keep their name; directories lose the trailing slash. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/?\*+$/, "")
    .replace(/\/+$/, "");
}

/** Same path, or one contains the other. "apps/api" overlaps "apps/api/src/app.ts", not "apps/api-old". */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Which side owns a path, per SIDE_PATHS. Undefined = shared ground (root docs), anyone may claim it. */
export function sideOf(path: string): Side | undefined {
  const p = normalizePath(path);
  for (const side of Object.keys(SIDE_PATHS) as Side[]) {
    for (const prefix of SIDE_PATHS[side]) {
      const owned = normalizePath(prefix);
      if (p === owned || p.startsWith(`${owned}/`)) return side;
    }
  }
  return undefined;
}

// Correct for a single API replica only; a multi-replica deployment needs a conditional write in the store.
const teamTails = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier fn for the same team has settled, so read-check-write never interleaves. */
export function withTeamLock<T>(team_id: string, fn: () => Promise<T>): Promise<T> {
  const prev = teamTails.get(team_id) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.catch(() => undefined); // a rejected fn must not poison the chain
  teamTails.set(team_id, tail);
  void tail.then(() => {
    if (teamTails.get(team_id) === tail) teamTails.delete(team_id);
  });
  return result;
}

/** Deduped, normalized, empty entries dropped. */
const cleanPaths = (paths: string[]) => [...new Set(paths.map(normalizePath).filter(Boolean))];

/** The two rules: paths stay on your side, and never overlap an open claim. Proposed tasks hold no paths. */
async function checkClaim(
  store: ContextStore,
  team_id: string,
  side: Side,
  paths: string[],
): Promise<TaskConflict | undefined> {
  const foreign = paths.filter((p) => {
    const owner = sideOf(p);
    return owner !== undefined && owner !== side;
  });
  if (foreign.length > 0) {
    return {
      error: `${foreign.join(", ")} belongs to the other side. Ask its owner on the Board instead of editing it.`,
      reason: "wrong_side",
      offending_paths: foreign,
      conflicts: [],
    };
  }

  const open = await store.tasks({ team_id, status: "claimed", limit: 200 });
  const conflicts = open.filter((t) => t.paths.some((held) => paths.some((p) => pathsOverlap(p, held))));
  if (conflicts.length === 0) return undefined;
  const offending = paths.filter((p) => conflicts.some((t) => t.paths.some((held) => pathsOverlap(p, held))));
  const holders = conflicts.map((t) => `${t.owner} ("${t.title}")`).join(", ");
  return {
    error: `${offending.join(", ")} is already claimed by ${holders}. Wait for it, or pick different paths.`,
    reason: "overlap",
    offending_paths: offending,
    conflicts,
  };
}

export async function claimTask(
  store: ContextStore,
  req: TaskClaimRequest,
  now: Date = new Date(),
): Promise<ClaimResult> {
  return withTeamLock(req.team_id, () => claimUnlocked(store, req, now));
}

async function claimUnlocked(store: ContextStore, req: TaskClaimRequest, now: Date): Promise<ClaimResult> {
  const paths = cleanPaths(req.paths);
  const conflict = await checkClaim(store, req.team_id, req.side, paths);
  if (conflict) return { ok: false, conflict };

  const at = now.toISOString();
  const task: TaskDoc = {
    team_id: req.team_id,
    id: crypto.randomUUID(),
    title: req.title,
    side: req.side,
    owner: req.who,
    paths,
    status: "claimed",
    created_at: at,
    updated_at: at,
  };
  await store.upsertTask(task);
  return { ok: true, task };
}

/**
 * Takes a proposed work order: it becomes a normal claim under exactly the claimTask rules.
 * Paths and side default to what jam proposed; spec and provenance are kept.
 */
export async function acceptTask(
  store: ContextStore,
  id: string,
  req: TaskAcceptRequest,
  now: Date = new Date(),
): Promise<AcceptResult> {
  return withTeamLock(req.team_id, () => acceptUnlocked(store, id, req, now));
}

async function acceptUnlocked(store: ContextStore, id: string, req: TaskAcceptRequest, now: Date): Promise<AcceptResult> {
  const all = await store.tasks({ team_id: req.team_id, limit: 200 });
  const current = all.find((t) => t.id === id);
  if (!current) return { ok: false, notFound: true };
  if (current.status !== "proposed") return { ok: false, error: `task is already ${current.status}` };

  const paths = cleanPaths(req.paths ?? current.paths);
  if (paths.length === 0) {
    return { ok: false, error: "this work order has no paths yet: pass the paths you will edit" };
  }
  const side = req.side ?? current.side;
  const conflict = await checkClaim(store, req.team_id, side, paths);
  if (conflict) return { ok: false, conflict };

  const task: TaskDoc = { ...current, status: "claimed", owner: req.who, paths, side, updated_at: now.toISOString() };
  await store.upsertTask(task);
  return { ok: true, task };
}

/** Marks a claim done or released, freeing its paths. Undefined if there is no such task for the team. */
export async function closeTask(
  store: ContextStore,
  id: string,
  req: TaskCloseRequest,
  now: Date = new Date(),
): Promise<TaskDoc | undefined> {
  return withTeamLock(req.team_id, async () => {
    const all = await store.tasks({ team_id: req.team_id, limit: 200 });
    const current = all.find((t) => t.id === id);
    if (!current) return undefined;
    const closed: TaskDoc = {
      ...current,
      status: req.status,
      pr: req.pr ?? current.pr,
      note: req.note ?? current.note,
      updated_at: now.toISOString(),
    };
    await store.upsertTask(closed);
    return closed;
  });
}
