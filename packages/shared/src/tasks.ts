// The delegator's rules. A claim says "this agent is editing these paths".
// A claim is refused if a path belongs to the other side, or overlaps an open claim.
// Pure logic over ContextStore, shared by the HTTP API and the MCP tools.
import type { ContextStore } from "./store";
import {
  SIDE_PATHS,
  type Side,
  type TaskClaimRequest,
  type TaskCloseRequest,
  type TaskConflict,
  type TaskDoc,
} from "./types";

export type ClaimResult = { ok: true; task: TaskDoc } | { ok: false; conflict: TaskConflict };

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

export async function claimTask(
  store: ContextStore,
  req: TaskClaimRequest,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const paths = [...new Set(req.paths.map(normalizePath).filter(Boolean))];

  const foreign = paths.filter((p) => {
    const owner = sideOf(p);
    return owner !== undefined && owner !== req.side;
  });
  if (foreign.length > 0) {
    return {
      ok: false,
      conflict: {
        error: `${foreign.join(", ")} belongs to the other side. Ask its owner on the Board instead of editing it.`,
        reason: "wrong_side",
        offending_paths: foreign,
        conflicts: [],
      },
    };
  }

  const open = await store.tasks({ team_id: req.team_id, status: "claimed", limit: 200 });
  const conflicts = open.filter((t) => t.paths.some((held) => paths.some((p) => pathsOverlap(p, held))));
  if (conflicts.length > 0) {
    const offending = paths.filter((p) =>
      conflicts.some((t) => t.paths.some((held) => pathsOverlap(p, held))),
    );
    const holders = conflicts.map((t) => `${t.owner} ("${t.title}")`).join(", ");
    return {
      ok: false,
      conflict: {
        error: `${offending.join(", ")} is already claimed by ${holders}. Wait for it, or pick different paths.`,
        reason: "overlap",
        offending_paths: offending,
        conflicts,
      },
    };
  }

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

/** Marks a claim done or released, freeing its paths. Undefined if there is no such task for the team. */
export async function closeTask(
  store: ContextStore,
  id: string,
  req: TaskCloseRequest,
  now: Date = new Date(),
): Promise<TaskDoc | undefined> {
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
}
