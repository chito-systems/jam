import { type CaptureStatus, type FeedEvent, type ItemDoc, MemoryStore, type RawDoc } from "@hh/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInlineDispatcher } from "./dispatcher";
import { createLibrarianFromEnv, type Librarian, type ModelItem, mapItems, OpenAILibrarian } from "./librarian";

const KEY = "sk-test-secret-key";
const raw = (seq: number, who = "cam"): RawDoc => ({
  team_id: "t1",
  id: `c1:${seq}`,
  capture_id: "c1",
  type: "voice",
  who,
  seq,
  text: `chunk ${seq}`,
  at: `2026-11-09T19:00:0${seq}.000Z`,
});
const old: ItemDoc = {
  team_id: "t1",
  id: "old-1",
  kind: "decision",
  text: "The team will use Postgres.",
  who: "cam",
  at: "2026-11-09T18:00:00.000Z",
  tags: ["storage"],
  raw_ids: ["c0:0"],
  status: "open",
};
const m = (over: Partial<ModelItem>): ModelItem => ({
  existing_id: null,
  kind: "decision",
  text: "The team will use Elasticsearch.",
  who: "cam",
  raw_ids: ["c1:1"],
  tags: ["Search"],
  status: "open",
  ...over,
});

function fakeFetch(status: number, content: unknown) {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const body = status === 200 ? { choices: [{ message: { content } }] } : "upstream sad";
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("mapItems", () => {
  const input = { team_id: "t1", docs: [raw(0), raw(1, "jake")], recent: [old] };

  it("assigns new ids, takes `at` from the first referenced chunk, normalizes tags", () => {
    const [item] = mapItems([m({ raw_ids: ["c1:1", "c1:0"] })], input, () => "new-1");
    expect(item).toMatchObject({ id: "new-1", team_id: "t1", at: raw(1).at, tags: ["search"], status: "open" });
  });

  it("drops unknown raw_ids and items left without any", () => {
    const items = mapItems([m({ raw_ids: ["nope", "c1:0"] }), m({ raw_ids: ["nope"] })], input);
    expect(items).toHaveLength(1);
    expect(items[0]?.raw_ids).toEqual(["c1:0"]);
  });

  it("supersedes an existing item by keeping its id and fields", () => {
    const items = mapItems([m({ existing_id: "old-1", status: "superseded", raw_ids: [] }), m({})], input);
    expect(items[0]).toEqual({ ...old, status: "superseded" });
    expect(items[1]?.id).not.toBe("old-1");
  });
});

describe("OpenAILibrarian", () => {
  const input = { team_id: "t1", docs: [raw(0)], recent: [] };

  it("posts a json_schema request and maps the answer", async () => {
    const { impl, calls } = fakeFetch(200, JSON.stringify({ items: [m({ raw_ids: ["c1:0"] })] }));
    const lib = new OpenAILibrarian({ apiKey: KEY, model: "test-model", fetchImpl: impl });
    const items = await lib.extract(input);
    expect(items).toHaveLength(1);
    const sent = JSON.parse(String(calls[0]?.body));
    expect(sent.model).toBe("test-model");
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.messages[1].content).toContain("c1:0");
  });

  it("throws a clear error on malformed model output", async () => {
    const lib = new OpenAILibrarian({ apiKey: KEY, fetchImpl: fakeFetch(200, "not json").impl });
    await expect(lib.extract(input)).rejects.toThrow(/invalid JSON/);
    const bad = new OpenAILibrarian({ apiKey: KEY, fetchImpl: fakeFetch(200, '{"items":[{"kind":"vibe"}]}').impl });
    await expect(bad.extract(input)).rejects.toThrow(/malformed item 0/);
  });

  it("throws on non-2xx with the status and never leaks the key", async () => {
    const lib = new OpenAILibrarian({ apiKey: KEY, fetchImpl: fakeFetch(500, "").impl });
    const err = await lib.extract(input).catch((e: Error) => e);
    expect(String(err)).toMatch(/500/);
    expect(String(err)).not.toContain(KEY);
  });
});

describe("createLibrarianFromEnv", () => {
  it("needs a key and respects LIBRARIAN=off", () => {
    expect(createLibrarianFromEnv({})).toBeUndefined();
    expect(createLibrarianFromEnv({ OPENAI_API_KEY: KEY, LIBRARIAN: "off" })).toBeUndefined();
    expect(createLibrarianFromEnv({ OPENAI_API_KEY: KEY })?.name).toBe("openai:gpt-5.4-mini");
    expect(createLibrarianFromEnv({ OPENAI_API_KEY: KEY, LIBRARIAN_MODEL: "x" })?.name).toBe("openai:x");
  });
});

describe("dispatcher + librarian", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const job = (source_ref?: string) => ({
    capture_id: "c1",
    team_id: "t1",
    who: "cam",
    type: "text" as const,
    at: "2026-11-09T19:00:00.000Z",
    received_at: "2026-11-09T19:00:00.000Z",
    text: "we decided to use the merge queue",
    source_ref,
  });

  function setup(extract: Librarian["extract"]) {
    const store = new MemoryStore();
    const calls: Array<{ docs: RawDoc[]; stateAtCall: string | undefined }> = [];
    const events: FeedEvent[] = [];
    let last: CaptureStatus | undefined;
    const d = createInlineDispatcher({
      store,
      librarian: {
        name: "fake",
        extract: async (input) => {
          calls.push({ docs: input.docs, stateAtCall: last?.state });
          return extract(input);
        },
      },
    });
    d.subscribe("t1", (e) => {
      events.push(e);
      if (e.event === "capture") last = e.data;
    });
    return { store, d, calls, events, state: () => last?.state };
  }

  it("runs after `indexed`, stores the items and publishes `item` events", async () => {
    const { store, d, calls, events } = setup(async ({ docs }) => [
      { ...old, id: "i1", raw_ids: [docs[0]?.id ?? ""] },
    ]);
    await d.dispatch(job());
    await vi.waitFor(() => expect(events.some((e) => e.event === "item")).toBe(true));
    expect(calls[0]?.stateAtCall).toBe("indexed");
    expect(await store.items({ team_id: "t1", limit: 10 })).toHaveLength(1);
  });

  it("a librarian failure leaves the capture indexed and logs once", async () => {
    const { d, calls, state } = setup(async () => {
      throw new Error("model down");
    });
    await d.dispatch(job());
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(state()).toBe("indexed");
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({ capture_id: "c1", team_id: "t1" });
  });

  it("skips PR and review captures (machine-made text is not mined for decisions)", async () => {
    const { d, calls, state } = setup(async () => []);
    await d.dispatch({ ...job(), type: "review" as const });
    await vi.waitFor(() => expect(state()).toBe("indexed"));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });

  it("skips task: captures", async () => {
    const { d, calls, state } = setup(async () => []);
    await d.dispatch(job("task:abc"));
    await vi.waitFor(() => expect(state()).toBe("indexed"));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });
});
