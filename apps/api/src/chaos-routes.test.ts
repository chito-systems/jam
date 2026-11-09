import { type ChaosState, type Dispatcher, type FeedEvent, type IngestJob, MemoryStore } from "@hh/shared";
import { describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "./app";
import { createChaosSwitch } from "./chaos-routes";

function setup(over: Partial<AppDeps> = {}) {
  const events: Array<{ team_id: string; event: FeedEvent }> = [];
  const jobs: IngestJob[] = [];
  const dispatcher = {
    publish: (team_id: string, event: FeedEvent) => {
      events.push({ team_id, event });
    },
    dispatch: async (job: IngestJob) => {
      jobs.push(job);
      return { capture_id: job.capture_id, state: "queued" };
    },
    captures: async () => [],
  } as unknown as Dispatcher;
  const chaos = createChaosSwitch(false);
  const app = createApp({ store: new MemoryStore(), dispatcher, chaos, ...over });
  const post = (body: unknown) =>
    app.request("/api/chaos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, chaos, events, jobs, post };
}

describe("/api/chaos", () => {
  it("is off by default", async () => {
    const { app } = setup();
    expect(await (await app.request("/api/chaos")).json()).toEqual({ enabled: false });
    // No switch handed in: createApp makes its own, off.
    const bare = createApp({ store: new MemoryStore(), dispatcher: {} as Dispatcher });
    expect(await (await bare.request("/api/chaos")).json()).toEqual({ enabled: false });
  });

  it("round-trips on and off, publishes a feed event and writes a brain note", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, chaos, events, jobs, post } = setup();
    const res = await post({ team_id: "t1", who: "cam", enabled: true });
    expect(res.status).toBe(200);
    const state = (await res.json()) as ChaosState;
    expect(state).toMatchObject({ enabled: true, changed_by: "cam" });
    expect(new Date(state.changed_at ?? "").toISOString()).toBe(state.changed_at);
    expect(chaos.get()).toEqual(state);
    expect(await (await app.request("/api/chaos")).json()).toEqual(state);
    expect(events).toEqual([{ team_id: "t1", event: { event: "chaos", data: state } }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ team_id: "t1", who: "cam", type: "text", source_ref: "chaos" });
    expect(jobs[0]?.text).toBe(
      "[chaos on] cam turned the chaos switch on: the index step now waits 3 s and fails 20% of the time",
    );

    const off = (await (await post({ team_id: "t1", who: "jake", enabled: false })).json()) as ChaosState;
    expect(off).toMatchObject({ enabled: false, changed_by: "jake" });
    expect(jobs[1]?.text).toMatch(/^\[chaos off\] jake /);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("rejects a bad body with 400", async () => {
    const { post } = setup();
    expect((await post({ team_id: "t1", enabled: "yes" })).status).toBe(400);
  });

  it("returns 403 and leaves the switch alone when CHAOS_SWITCH=off", async () => {
    const { chaos, events, post } = setup({ allowChaosSwitch: false });
    const res = await post({ team_id: "t1", who: "cam", enabled: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty("error");
    expect(chaos.get().enabled).toBe(false);
    expect(events).toEqual([]);
  });

  it("shows the flag in /api/stats", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, post } = setup();
    const stats = async () => (await (await app.request("/api/stats?team_id=t1")).json()) as { chaos?: boolean };
    expect((await stats()).chaos).toBe(false);
    await post({ team_id: "t1", who: "cam", enabled: true });
    expect((await stats()).chaos).toBe(true);
    vi.restoreAllMocks();
  });
});
