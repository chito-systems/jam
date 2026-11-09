import type { ItemDoc, RawDoc } from "@hh/shared";
import { describe, expect, it } from "vitest";
import {
  cleanPaths,
  createPlannerFromEnv,
  draftTitle,
  type ModelWorkOrder,
  OpenAIPlanner,
  PR_RULE,
  type PlannerInput,
} from "./planner";

const chunk: RawDoc = {
  team_id: "t1",
  id: "c1:0",
  capture_id: "c1",
  type: "voice",
  who: "cam",
  seq: 0,
  at: "2026-11-09T20:04:00.000Z", // 1:04 PM MT
  text: "ok so. Jake, can you add confirm and reject buttons to the decisions list in the UI? thanks",
};
const todo: ItemDoc = {
  team_id: "t1",
  id: "todo-1",
  kind: "todo",
  text: "Jake adds confirm and reject buttons to the decisions list in the UI.",
  who: "cam",
  at: chunk.at,
  tags: ["ui"],
  raw_ids: ["c1:0"],
  status: "open",
  confidence: 0.9,
};
const decision: ItemDoc = { ...todo, id: "d1", kind: "decision", text: "Rejected items stay visible, marked as rejected." };
const input: PlannerInput = { todo, quotes: [chunk], decisions: [decision] };

const model = (over: Partial<ModelWorkOrder> = {}): ModelWorkOrder => ({
  title: "Add confirm and reject buttons to the decisions list.",
  goal: "People can grade each decision from the list.",
  quotes: [{ raw_id: "c1:0", excerpt: "Jake, can you add confirm and reject buttons to the decisions list in the UI?" }],
  acceptance_criteria: ["- [ ] Each decision shows Confirm and Reject", "A click sends the verdict", "Tests cover both"],
  decision_ids: ["d1", "nope"],
  software: true,
  paths: ["apps/web/src", "./apps/web/src/**", "../etc/passwd", "src/made/up.ts"],
  ...over,
});

function fakeFetch(status: number, content: unknown) {
  const bodies: unknown[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const body = status === 200 ? { choices: [{ message: { content } }] } : "upstream sad";
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, bodies };
}

const planner = (f: ReturnType<typeof fakeFetch>) => new OpenAIPlanner({ apiKey: "sk-test", fetchImpl: f.impl });

describe("OpenAIPlanner", () => {
  it("maps the model's parts into a title, clean paths and the spec shape", async () => {
    const f = fakeFetch(200, JSON.stringify(model()));
    const draft = await planner(f).draft(input);
    expect(draft.title).toBe("Add confirm and reject buttons to the decisions list");
    expect(draft.paths).toEqual(["apps/web/src"]);
    expect(draft.spec).toBe(
      [
        "## Goal",
        "People can grade each decision from the list.",
        "",
        "## Why (from the team's own words)",
        '> "Jake, can you add confirm and reject buttons to the decisions list in the UI?" — cam, 1:04 PM MT (`c1:0`)',
        "",
        "## Acceptance criteria",
        "- [ ] Each decision shows Confirm and Reject",
        "- [ ] A click sends the verdict",
        "- [ ] Tests cover both",
        "",
        "## Constraints",
        "- Rejected items stay visible, marked as rejected.",
        `- ${PR_RULE}`,
      ].join("\n"),
    );
    const sent = f.bodies[0] as { response_format: { type: string }; messages: { content: string }[] };
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.messages[1]?.content).toContain("apps/web/src");
    expect(sent.messages[1]?.content).toContain('"id":"d1"');
  });

  it("replaces a paraphrased quote with the chunk itself, and drops paths and the PR rule for non-software", async () => {
    const f = fakeFetch(
      200,
      JSON.stringify(model({ software: false, decision_ids: [], quotes: [{ raw_id: "c1:0", excerpt: "please add buttons" }] })),
    );
    const draft = await planner(f).draft(input);
    expect(draft.paths).toEqual([]);
    expect(draft.spec).toContain(`> "${chunk.text}" — cam`);
    expect(draft.spec).not.toContain("## Constraints");
  });

  it("falls back to the todo text when the model's title is only punctuation", async () => {
    const draft = await planner(fakeFetch(200, JSON.stringify(model({ title: " ... " })))).draft(input);
    expect(draft.title).toBe("Jake adds confirm and reject buttons to the decisions list in the UI");
    expect(draftTitle("", "x".repeat(200))).toHaveLength(80);
  });

  it("throws a clear error on malformed output and on HTTP failure", async () => {
    await expect(planner(fakeFetch(200, "not json")).draft(input)).rejects.toThrow(/invalid JSON/);
    await expect(planner(fakeFetch(200, JSON.stringify({ title: "x" }))).draft(input)).rejects.toThrow(/malformed/);
    await expect(planner(fakeFetch(500, "")).draft(input)).rejects.toThrow(/OpenAI planner failed: 500/);
  });
});

describe("cleanPaths and env", () => {
  it("keeps known territory and root files, at most six", () => {
    expect(cleanPaths(["README.md", "Dockerfile.api", ".github/workflows", "/abs", "lib/x"])).toEqual([
      "README.md",
      "Dockerfile.api",
      ".github/workflows",
    ]);
    expect(cleanPaths(Array.from({ length: 9 }, (_, i) => `apps/web/src/f${i}.tsx`))).toHaveLength(6);
  });

  it("builds from env unless off or keyless", () => {
    expect(createPlannerFromEnv({ OPENAI_API_KEY: "k", PLANNER_MODEL: "m" })?.name).toBe("openai:m");
    expect(createPlannerFromEnv({ OPENAI_API_KEY: "k", PLANNER: "off" })).toBeUndefined();
    expect(createPlannerFromEnv({})).toBeUndefined();
  });
});
