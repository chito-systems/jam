// GET /api/ownership: which side owns a path, its captain, and who holds it right now. Pure reads.
import {
  type ApiError,
  type ContextStore,
  type OwnershipMapResponse,
  type OwnershipResponse,
  ownershipMap,
  ownershipOf,
  parseRoster,
  type RosterEntry,
} from "@hh/shared";
import type { Hono } from "hono";

export const OWNERSHIP_ROUTE = "/api/ownership";

export function registerOwnershipRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: shares the app's env without importing it
  app: Hono<any>,
  { store, roster = parseRoster(process.env.JAM_ROSTER) }: { store: ContextStore; roster?: RosterEntry[] },
) {
  app.get(OWNERSHIP_ROUTE, async (c) => {
    const team_id = c.req.query("team_id")?.trim();
    if (!team_id) return c.json({ error: "team_id is required" } satisfies ApiError, 400);
    const path = c.req.query("path")?.trim();
    if (path) return c.json((await ownershipOf(store, { team_id, path, roster })) satisfies OwnershipResponse);
    return c.json((await ownershipMap(store, { team_id, roster })) satisfies OwnershipMapResponse);
  });
}
