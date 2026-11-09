// Grading: POST /api/items/:id/verdict. A person confirms or rejects what the librarian extracted.
// The item stays stored either way; rejected items just leave the decision log.
import {
  type ApiError,
  type ContextStore,
  type Dispatcher,
  ItemVerdictRequestSchema,
  ROUTES,
  setItemVerdict,
} from "@hh/shared";
import type { Hono } from "hono";

const apiError = (error: string, detail?: unknown): ApiError =>
  detail === undefined ? { error } : { error, detail };

export function registerItemRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: shares the app's env without importing it
  app: Hono<any>,
  { store, dispatcher }: { store: ContextStore; dispatcher: Dispatcher },
) {
  app.post(ROUTES.itemVerdict, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json(apiError("body is not valid JSON", String(err)), 400);
    }
    const parsed = ItemVerdictRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(apiError("invalid request", parsed.error.issues), 400);
    const { team_id, who, verdict } = parsed.data;
    const item = await setItemVerdict(store, { team_id, id: c.req.param("id"), who, verdict });
    if (!item) return c.json(apiError("item not found"), 404);
    dispatcher.publish(team_id, { event: "item", data: item });
    return c.json(item);
  });
}
