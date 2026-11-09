import { describe, expect, it } from "vitest";
import { parseRoster } from "./assign";
import { createPresence, MAX_AGENTS_PER_TEAM, MAX_TEAMS, toAgentDoc } from "./presence";
import type { TaskDoc } from "./types";

const clock = (start = Date.parse("2026-11-09T18:00:00.000Z")) => {
  let t = start;
  return { now: () => new Date(t), tick: (ms: number) => (t += ms) };
};

describe("createPresence", () => {
  it("creates then updates an entry; only tool calls count", () => {
    const c = clock();
    const p = createPresence({ now: c.now });
    p.seen({ team_id: "t1", who: "cam-opus-1", side: "backend" });
    c.tick(1000);
    p.seen({ team_id: "t1", who: "cam-opus-1", tool: "task_claim" });
    const [e] = p.list("t1");
    expect(e).toMatchObject({
      who: "cam-opus-1",
      side: "backend", // kept when a later call has no side
      first_seen: "2026-11-09T18:00:00.000Z",
      last_seen: "2026-11-09T18:00:01.000Z",
      last_tool: "task_claim",
      calls: 1,
    });
    expect(p.list("t2")).toEqual([]);
  });

  it("lists most recently seen first and drops the least recently seen past the cap", () => {
    const c = clock();
    const p = createPresence({ now: c.now });
    for (let i = 0; i <= MAX_AGENTS_PER_TEAM; i++) {
      p.seen({ team_id: "t1", who: `a-${i}` });
      c.tick(1000);
    }
    const list = p.list("t1");
    expect(list).toHaveLength(MAX_AGENTS_PER_TEAM);
    expect(list[0]?.who).toBe(`a-${MAX_AGENTS_PER_TEAM}`);
    expect(list.some((e) => e.who === "a-0")).toBe(false);
  });
});

describe("createPresence team cap", () => {
  it("evicts the team seen least recently when a new team would exceed the cap", () => {
    const c = clock();
    const p = createPresence({ now: c.now });
    for (let i = 0; i < MAX_TEAMS; i++) {
      p.seen({ team_id: `t${i}`, who: "a" });
      c.tick(1000);
    }
    p.seen({ team_id: "t0", who: "a" }); // t0 is fresh again, so t1 is now the stalest
    c.tick(1000);
    p.seen({ team_id: "new", who: "a" });
    expect(p.list("t1")).toEqual([]);
    expect(p.list("t0")).toHaveLength(1);
    expect(p.list("t2")).toHaveLength(1);
    expect(p.list("new")).toHaveLength(1);
  });
});

describe("toAgentDoc", () => {
  const roster = parseRoster("cam:backend,jake:frontend");
  const now = new Date("2026-11-09T18:00:00.000Z");
  const entry = (who: string, last_seen = "2026-11-09T17:59:00.000Z") => ({
    team_id: "t1",
    who,
    first_seen: last_seen,
    last_seen,
    calls: 0,
  });
  const claim = (owner: string) => ({ owner, status: "claimed", title: "x", paths: ["apps/api/"] }) as TaskDoc;

  it("matches the human by roster prefix", () => {
    const human = (who: string) => toAgentDoc(entry(who), { roster, claims: [], now }).human;
    expect(human("cam-opus-1")).toBe("cam");
    expect(human("camera-1")).toBeUndefined();
    expect(human("jake")).toBe("jake");
  });

  it("derives state from last_seen", () => {
    const state = (at: string) => toAgentDoc(entry("cam", at), { roster, claims: [], now }).state;
    expect(state("2026-11-09T17:58:30.000Z")).toBe("active");
    expect(state("2026-11-09T17:50:00.000Z")).toBe("idle");
    expect(state("2026-11-09T17:40:00.000Z")).toBe("gone");
  });

  it("keeps only its own claims", () => {
    const doc = toAgentDoc(entry("cam-opus-1"), { roster, claims: [claim("agent:cam-opus-1"), claim("agent:x")], now });
    expect(doc).toMatchObject({ id: "agent:cam-opus-1", name: "cam-opus-1" });
    expect(doc.claims.map((t) => t.owner)).toEqual(["agent:cam-opus-1"]);
  });
});
