// "Who is in charge of this file, and is anyone working on it right now?" Pure reads over ContextStore,
// plus the clash notice both the HTTP API and the MCP tools send when the delegator refuses a claim.
import type { RosterEntry } from "./assign";
import type { Dispatcher } from "./pipeline";
import type { ContextStore } from "./store";
import { normalizePath, pathsOverlap, sideOf } from "./tasks";
import { SIDE_PATHS, type Side, type TaskConflict, type TaskDoc } from "./types";

/** GET /api/ownership?team_id=&path= */
export interface OwnershipResponse {
  path: string; // normalized
  side?: Side; // undefined = shared ground, anyone may claim it
  captain?: string; // first roster name on that side
  held_by: TaskDoc[]; // open claims overlapping the path
  proposed: TaskDoc[]; // proposed work orders overlapping the path
}

export interface OwnershipSide {
  side: Side;
  paths: string[];
  captain?: string;
  claims: Pick<TaskDoc, "id" | "title" | "owner" | "paths">[];
}

/** GET /api/ownership?team_id= (no path) */
export interface OwnershipMapResponse {
  sides: OwnershipSide[];
}

const captainOf = (roster: RosterEntry[], side: Side | undefined) =>
  side === undefined ? undefined : roster.find((e) => e.side === side)?.name;

export async function ownershipOf(
  store: ContextStore,
  { team_id, path, roster }: { team_id: string; path: string; roster: RosterEntry[] },
): Promise<OwnershipResponse> {
  const p = normalizePath(path);
  const side = sideOf(p);
  const [claimed, proposed] = await Promise.all([
    store.tasks({ team_id, status: "claimed", limit: 200 }),
    store.tasks({ team_id, status: "proposed", limit: 200 }),
  ]);
  const touches = (t: TaskDoc) => t.paths.some((held) => pathsOverlap(held, p));
  const captain = captainOf(roster, side);
  return {
    path: p,
    ...(side ? { side } : {}),
    ...(captain ? { captain } : {}),
    held_by: claimed.filter(touches),
    proposed: proposed.filter(touches),
  };
}

export async function ownershipMap(
  store: ContextStore,
  { team_id, roster }: { team_id: string; roster: RosterEntry[] },
): Promise<OwnershipMapResponse> {
  const claimed = await store.tasks({ team_id, status: "claimed", limit: 200 });
  const sides = (Object.keys(SIDE_PATHS) as Side[]).map((side): OwnershipSide => {
    const captain = captainOf(roster, side);
    return {
      side,
      paths: [...SIDE_PATHS[side]],
      ...(captain ? { captain } : {}),
      claims: claimed
        .filter((t) => t.side === side)
        .map(({ id, title, owner, paths }) => ({ id, title, owner, paths })),
    };
  });
  return { sides };
}

/** The one-line brain note for a refused claim. */
export function clashText(who: string, side: Side | undefined, conflict: TaskConflict): string {
  const paths = conflict.offending_paths.join(", ");
  if (conflict.reason === "wrong_side") {
    const theirs = sideOf(conflict.offending_paths[0] ?? "");
    return `[clash] ${who} (${side ?? "no side"}) tried to claim ${paths}, which belong to the ${theirs ?? "other"} side`;
  }
  const holders = conflict.conflicts.map((t) => `${t.owner} holds them for "${t.title}"`).join(" and ");
  return `[clash] ${who} tried to claim ${paths} but ${holders}`;
}

/**
 * A refused claim: lights up each holder's task on the live feed and writes one brain note.
 * Best-effort: a failed brain write is logged, never thrown, so the refusal the caller returns is unchanged.
 */
export async function reportClash(
  dispatcher: Dispatcher,
  { team_id, who, side, conflict }: { team_id: string; who: string; side?: Side; conflict: TaskConflict },
): Promise<void> {
  for (const task of conflict.conflicts) dispatcher.publish(team_id, { event: "task", data: task });
  // A wrong-side refusal without a declared side: the requester is on the side the paths don't belong to.
  const owner = sideOf(conflict.offending_paths[0] ?? "");
  const mine = side ?? (conflict.reason === "wrong_side" && owner ? (owner === "backend" ? "frontend" : "backend") : undefined);
  const now = new Date().toISOString();
  try {
    await dispatcher.dispatch({
      capture_id: crypto.randomUUID(),
      team_id,
      who,
      type: "text",
      ...(mine ? { side: mine } : {}),
      at: now,
      received_at: now,
      source_ref: "clash",
      text: clashText(who, mine, conflict),
    });
  } catch (err) {
    console.error(`clash brain write failed team_id=${team_id} who=${who}:`, err);
  }
}
