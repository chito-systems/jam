import { type Dispatcher, type ItemDoc, MemoryStore, type RawDoc } from "@hh/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { escapeInline, registerDecisionRoutes } from "./decisions-routes";

const NOW = new Date("2026-11-09T21:05:00.000Z"); // 2:05 PM MST

const raw = (id: string, text: string, at: string, who = "cam"): RawDoc => ({
  team_id: "t1",
  id,
  capture_id: id.split(":")[0] ?? id,
  type: "voice",
  who,
  at,
  seq: 0,
  text,
});

const item = (id: string, text: string, at: string, extra: Partial<ItemDoc> = {}): ItemDoc => ({
  team_id: "t1",
  id,
  kind: "decision",
  text,
  who: "cam",
  at,
  tags: [],
  raw_ids: [],
  status: "open",
  ...extra,
});

async function setup(raws: RawDoc[] = [], items: ItemDoc[] = []) {
  const store = new MemoryStore();
  await store.indexRaw(raws);
  await store.indexItems(items);
  const app = new Hono();
  registerDecisionRoutes(app, { store, now: () => NOW });
  const get = async (qs: string) => {
    const res = await app.request(`/api/decisions.md${qs}`);
    return { res, md: await res.text() };
  };
  return { store, get };
}

const seeded = () =>
  setup(
    [
      raw("a:0", "ok let's just use the merge queue, no direct pushes", "2026-11-09T20:41:30.000Z"),
      raw("b:0", "we'll keep everything on one node", "2026-11-09T19:10:05.000Z", "jake"),
    ],
    [
      item("d2", "Use the merge queue for every PR.", "2026-11-09T20:42:00.000Z", {
        raw_ids: ["a:0"],
        tags: ["git", "ci"],
      }),
      item("d1", "Run everything on one node.", "2026-11-09T19:10:00.000Z", {
        raw_ids: ["b:0"],
        who: "jake",
        status: "superseded",
      }),
      item("d3", "Ship the README last.", "2026-11-09T21:00:00.000Z", { raw_ids: ["gone:0"] }),
      item("t1", "Write the demo script.", "2026-11-09T20:00:00.000Z", { kind: "todo", raw_ids: ["a:0"] }),
      item("t2", "Done thing.", "2026-11-09T20:01:00.000Z", { kind: "todo", status: "done" }),
      item("q1", "Who presents?", "2026-11-09T20:02:00.000Z", { kind: "question" }),
    ],
  );

describe("GET /api/decisions.md", () => {
  it("is registered on the real app and needs a team_id", async () => {
    const app = createApp({ store: new MemoryStore(), dispatcher: {} as Dispatcher });
    const res = await app.request("/api/decisions.md");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("team_id") });
    const ok = await app.request("/api/decisions.md?team_id=t1");
    expect(ok.status).toBe(200);
  });

  it("serves markdown, oldest first, in Denver time, with receipts", async () => {
    const { res, md } = await (await seeded()).get("?team_id=t1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md).toContain("# Decision log — t1");
    expect(md).toContain("_Generated 2026-11-09 14:05 MT");
    expect(md).toContain("**3 decisions** · 0 confirmed · 1 superseded · 0 rejected and hidden");
    const order = ["Run everything", "Use the merge queue", "Ship the README"].map((s) => md.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(md).toContain("## 1:42 PM — Use the merge queue for every PR.");
    expect(md).toContain("Decided by **cam** · tags: `git` `ci`");
    expect(md).toContain(
      `> "ok let's just use the merge queue, no direct pushes" — cam, 1:41:30 PM, voice (\`a:0\`)`,
    );
    expect(md).not.toContain("Open todos");
  });

  it("strikes through superseded decisions and still renders lost sources", async () => {
    const { md } = await (await seeded()).get("?team_id=t1");
    expect(md).toContain("## ~~12:10 PM — Run everything on one node.~~");
    expect(md).toContain("Superseded · decided by **jake**");
    expect(md).toContain("## 2:00 PM — Ship the README last.");
    expect(md).toContain("> (source chunk not found) (`gone:0`)");
  });

  it("adds open todo and question sections with kinds=", async () => {
    const { md } = await (await seeded()).get("?team_id=t1&kinds=todo,question");
    expect(md).toContain("## Open todos (1)");
    expect(md).toContain("- 1:00 PM — Write the demo script. — **cam**");
    expect(md).toContain("  > same source as above (`a:0`)");
    expect(md).not.toContain("Done thing.");
    expect(md).toContain("## Open questions (1)");
    expect(md).toContain("  > (source chunk not found)");
    expect(md.indexOf("Open todos")).toBeGreaterThan(md.indexOf("Ship the README"));
  });

  it("quotes a chunk once per response and back-references repeats", async () => {
    const { md } = await (
      await setup(
        [raw("s:0", "one chunk, two decisions", "2026-11-09T20:00:00.000Z")],
        [
          item("d1", "First.", "2026-11-09T20:00:00.000Z", { raw_ids: ["s:0"] }),
          item("d2", "Second.", "2026-11-09T20:01:00.000Z", { raw_ids: ["s:0"] }),
        ],
      )
    ).get("?team_id=t1");
    expect(md.split('> "one chunk, two decisions"').length - 1).toBe(1);
    expect(md.indexOf("> same source as above (`s:0`)")).toBeGreaterThan(md.indexOf("Second."));
  });

  it("flags truncation at 200 decisions and not below", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 10, 9, 15, 0, 0, n)).toISOString();
    const many = (count: number) =>
      Array.from({ length: count }, (_, n) => item(`d${n}`, `Decision ${n}.`, at(n)));
    const note = "_Showing the newest 200 decisions; older ones exist and are not listed._";
    expect((await (await setup([], many(201))).get("?team_id=t1")).md).toContain(note);
    expect((await (await setup([], many(199))).get("?team_id=t1")).md).not.toContain(note);
  });

  it("looks up every raw id in batches of 500, so found chunks are never 'not found'", async () => {
    const ids = Array.from({ length: 600 }, (_, n) => `r${n}:0`);
    const { store, get } = await setup(
      ids.map((id) => raw(id, `chunk ${id}`, "2026-11-09T20:00:00.000Z")),
      [item("d", "Big one.", "2026-11-09T20:00:00.000Z", { raw_ids: ids })],
    );
    const sizes: number[] = [];
    const real = store.rawByIds.bind(store);
    // Behave like ElasticStore: anything past the cap is never looked up.
    store.rawByIds = async (team, batch) => {
      sizes.push(batch.length);
      return real(team, batch.slice(0, 500));
    };
    const { md } = await get("?team_id=t1");
    expect(sizes).toEqual([500, 100]);
    expect(md).not.toContain("not found");
    expect(md).toContain("(`r599:0`)");
  });

  it("rejects unknown kinds", async () => {
    const { res } = await (await setup()).get("?team_id=t1&kinds=todo,vibes");
    expect(res.status).toBe(400);
  });

  it("escapes untrusted transcript text", async () => {
    const nasty = "# boom\n| a | b |\n`rm -rf` <script> **bold** ~~gone~~";
    const { md } = await (
      await setup([raw("x:0", nasty, "2026-11-09T20:00:00.000Z")], [item("d", nasty, "2026-11-09T20:00:00.000Z", { raw_ids: ["x:0"] })])
    ).get("?team_id=t1");
    expect(md).not.toMatch(/^# boom/m);
    expect(md).not.toMatch(/^\|/m);
    expect(md).toContain("\\# boom \\| a \\| b \\| \\`rm -rf\\` \\<script\\> \\*\\*bold\\*\\* \\~\\~gone\\~\\~");
    expect(escapeInline("a\n\nb")).toBe("a b");
  });

  it("trims long quotes", async () => {
    const long = `${"word ".repeat(100)}end`;
    const { md } = await (
      await setup([raw("l:0", long, "2026-11-09T20:00:00.000Z")], [item("d", "Long.", "2026-11-09T20:00:00.000Z", { raw_ids: ["l:0"] })])
    ).get("?team_id=t1");
    const quote = md.split("\n").find((l) => l.startsWith('> "')) ?? "";
    expect(quote).toContain("…");
    expect(quote).not.toContain("end");
  });

  it("says so when there are no decisions yet", async () => {
    const { res, md } = await (await setup()).get("?team_id=t1");
    expect(res.status).toBe(200);
    expect(md).toContain("No decisions captured yet.");
    expect(md).not.toContain("**0 decisions**");
  });

  it("hides rejected items, counts them, and shows who confirmed or how sure the librarian was", async () => {
    const at = "2026-11-09T20:00:00.000Z";
    const { md } = await (
      await setup(
        [],
        [
          item("ok", "Use JAM as the name.", at, { verdict: "confirmed", verified_by: "jake", confidence: 0.95 }),
          item("maybe", "Deploy with Argo.", at, { confidence: 0.82 }),
          item("bare", "Ship by five.", at),
          item("no", "The cluster team is JAM.", at, { verdict: "rejected", verified_by: "cam" }),
          item("q", "A rejected question?", at, { kind: "question", verdict: "rejected" }),
        ],
      )
    ).get("?team_id=t1&kinds=question");
    expect(md).toContain("**3 decisions** · 1 confirmed · 0 superseded · 1 rejected and hidden");
    expect(md).toContain("Decided by **cam** · confirmed by **jake**");
    expect(md).toContain("Decided by **cam** · unconfirmed (librarian confidence 0.82)");
    expect(md).toMatch(/Ship by five\.\nDecided by \*\*cam\*\*\n/);
    expect(md).not.toContain("The cluster team is JAM");
    expect(md).not.toContain("A rejected question");
    expect(md).toContain("## Open questions (0)");
  });
});
