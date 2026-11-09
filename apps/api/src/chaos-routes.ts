// The chaos switch: flip the worker's index-step chaos on and off at runtime, no redeploy.
import { type ApiError, type ChaosState, ChaosRequestSchema, type Dispatcher, ROUTES } from "@hh/shared";
import type { Hono } from "hono";

export interface ChaosSwitch {
  get(): ChaosState;
  set(enabled: boolean, who: string): ChaosState;
}

/** In-process, global (not per team): one API process runs one pipeline. */
export function createChaosSwitch(initial: boolean): ChaosSwitch {
  let state: ChaosState = { enabled: initial };
  return {
    get: () => state,
    set(enabled, who) {
      state = { enabled, changed_at: new Date().toISOString(), changed_by: who };
      return state;
    },
  };
}

const apiError = (error: string, detail?: unknown): ApiError =>
  detail === undefined ? { error } : { error, detail };

export const chaosBrainText = (enabled: boolean, who: string) =>
  enabled
    ? `[chaos on] ${who} turned the chaos switch on: the index step now waits 3 s and fails 20% of the time`
    : `[chaos off] ${who} turned the chaos switch off: the index step is back to normal`;

export function registerChaosRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: shares the app's env without importing it
  app: Hono<any>,
  deps: { dispatcher: Dispatcher; chaos: ChaosSwitch; allowSwitch: boolean },
) {
  const { dispatcher, chaos } = deps;

  app.get(ROUTES.chaos, (c) => c.json(chaos.get()));

  app.post(ROUTES.chaos, async (c) => {
    if (!deps.allowSwitch) {
      return c.json(apiError("chaos switch is disabled on this deployment (CHAOS_SWITCH=off)"), 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json(apiError("body is not valid JSON", String(err)), 400);
    }
    const parsed = ChaosRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(apiError("invalid request", parsed.error.issues), 400);
    const { team_id, who, enabled } = parsed.data;

    const state = chaos.set(enabled, who);
    console.warn(`chaos switch ${enabled ? "ON" : "OFF"} by ${who} team_id=${team_id}`);
    dispatcher.publish(team_id, { event: "chaos", data: state });
    const now = new Date().toISOString();
    try {
      await dispatcher.dispatch({
        capture_id: crypto.randomUUID(),
        team_id,
        who,
        type: "text",
        at: now,
        received_at: now,
        source_ref: "chaos",
        text: chaosBrainText(enabled, who),
      });
    } catch (err) {
      // Best-effort: the switch already flipped; a failed brain note must not hide that.
      console.error(`chaos brain write failed team_id=${team_id}:`, err);
    }
    return c.json(state);
  });
}
