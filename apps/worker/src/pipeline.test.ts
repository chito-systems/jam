import { type IngestJob, MemoryStore } from "@hh/shared";
import { describe, expect, it } from "vitest";
import { CHAOS_DELAY_MS, type PipelineDeps, runPipeline } from "./pipeline";

const job = (n: number): IngestJob => ({
  capture_id: `c${n}`,
  team_id: "t1",
  who: "cam",
  type: "text",
  at: "2026-11-09T19:00:00.000Z",
  received_at: "2026-11-09T19:00:00.000Z",
  text: `capture ${n}`,
});

describe("runPipeline chaos switch", () => {
  it("reads a chaos function per job, so it can flip between jobs", async () => {
    let on = false;
    const sleeps: number[] = [];
    const deps: PipelineDeps = {
      store: new MemoryStore(),
      chaos: () => on,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.1, // below the failure rate: fails whenever chaos applies
    };
    await expect(runPipeline(job(1), deps, () => {})).resolves.toHaveLength(1);
    on = true;
    await expect(runPipeline(job(2), deps, () => {})).rejects.toThrow("chaos: injected index failure");
    on = false;
    await expect(runPipeline(job(3), deps, () => {})).resolves.toHaveLength(1);
    expect(sleeps).toEqual([CHAOS_DELAY_MS]);
  });

  it("stays off when chaos is absent or a function returning false", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const store = new MemoryStore();
    await runPipeline(job(1), { store, sleep, random: () => 0 }, () => {});
    await runPipeline(job(2), { store, chaos: () => false, sleep, random: () => 0 }, () => {});
    expect(sleeps).toEqual([]);
  });
});
