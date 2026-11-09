// GET /api/agents: which coding agents are on the team, who they work for, and what they hold. Pure reads.
import {
  type ApiError,
  AgentsResponseSchema,
  type ContextStore,
  type Presence,
  parseRoster,
  type RosterEntry,
  ROUTES,
  sortAgents,
  toAgentDoc,
} from "@hh/shared";
import type { Hono } from "hono";

export function registerAgentRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: shares the app's env without importing it
  app: Hono<any>,
  {
    store,
    presence,
    roster = parseRoster(process.env.JAM_ROSTER),
  }: { store: ContextStore; presence: Presence; roster?: RosterEntry[] },
) {
  app.get(ROUTES.agents, async (c) => {
    const team_id = c.req.query("team_id")?.trim();
    if (!team_id) return c.json({ error: "team_id is required" } satisfies ApiError, 400);
    const claims = await store.tasks({ team_id, status: "claimed", limit: 200 });
    const now = new Date();
    const agents = sortAgents(presence.list(team_id).map((e) => toAgentDoc(e, { roster, claims, now })));
    return c.json(AgentsResponseSchema.parse({ agents }));
  });
}
