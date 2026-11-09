import { type Dispatcher, type FeedEvent, type ItemDoc, MemoryStore } from "@hh/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const item: ItemDoc = {
  team_id: "t1",
  id: "i1",
  kind: "decision",
  text: "The user-facing name is JAM.",
  who: "cam",
  at: "2026-11-09T19:00:00.000Z",
  tags: [],
  raw_ids: ["c1:0"],
  status: "open",
  confidence: 0.82,
};

async function setup() {
  const store = new MemoryStore();
  await store.indexItems([item, { ...item, id: "other-team", team_id: "t2" }]);
  const events: Array<{ team_id: string; event: FeedEvent }> = [];
  const dispatcher = {
    publish: (team_id: string, event: FeedEvent) => {
      events.push({ team_id, event });
    },
  } as unknown as Dispatcher; // the verdict route only publishes
  const app = createApp({ store, dispatcher });
  const verdict = (id: string, body: unknown) =>
    app.request(`/api/items/${id}/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { store, app, events, verdict };
}

describe("POST /api/items/:id/verdict", () => {
  it("confirms an item, stores it, publishes it and returns the ItemDoc", async () => {
    const { store, events, verdict } = await setup();
    const res = await verdict("i1", { team_id: "t1", who: "jake", verdict: "confirmed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemDoc;
    expect(body).toMatchObject({ ...item, verdict: "confirmed", verified_by: "jake" });
    expect(new Date(body.verified_at ?? "").toISOString()).toBe(body.verified_at);
    expect(await store.itemById("t1", "i1")).toEqual(body);
    expect(events).toEqual([{ team_id: "t1", event: { event: "item", data: body } }]);
  });

  it("is idempotent for the same verdict and overwrites with a different one", async () => {
    const { store, verdict } = await setup();
    await verdict("i1", { team_id: "t1", who: "jake", verdict: "confirmed" });
    expect((await verdict("i1", { team_id: "t1", who: "jake", verdict: "confirmed" })).status).toBe(200);
    await verdict("i1", { team_id: "t1", who: "cam", verdict: "rejected" });
    expect(await store.itemById("t1", "i1")).toMatchObject({ verdict: "rejected", verified_by: "cam" });
  });

  it("filters GET /api/items by verdict", async () => {
    const { app, verdict } = await setup();
    await verdict("i1", { team_id: "t1", who: "jake", verdict: "confirmed" });
    const hit = await app.request("/api/items?team_id=t1&verdict=confirmed");
    expect(((await hit.json()) as { items: ItemDoc[] }).items.map((i) => i.id)).toEqual(["i1"]);
    const miss = await app.request("/api/items?team_id=t1&verdict=rejected");
    expect(((await miss.json()) as { items: ItemDoc[] }).items).toEqual([]);
  });

  it("404s an unknown id or another team's item, 400s a bad body", async () => {
    const { verdict, events } = await setup();
    expect((await verdict("nope", { team_id: "t1", who: "jake", verdict: "confirmed" })).status).toBe(404);
    expect((await verdict("other-team", { team_id: "t1", who: "jake", verdict: "confirmed" })).status).toBe(404);
    expect((await verdict("i1", { team_id: "t1", who: "jake", verdict: "maybe" })).status).toBe(400);
    expect((await verdict("i1", "{not json")).status).toBe(400);
    expect(events).toEqual([]);
  });
});
