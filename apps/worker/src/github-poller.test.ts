import { type CaptureStatus, type Dispatcher, type IngestJob, MemoryStore } from "@hh/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubPoller, createGithubPollerFromEnv } from "./github-poller";

const NOW = new Date("2026-11-09T20:00:00.000Z");
const REPO = "chito-systems/jam";
const issue = (n: number) => `https://api.github.com/repos/${REPO}/issues/${n}`;

const comment = (id: number, n: number, login: string, body: string, at = "2026-11-09T18:00:00Z") => ({
  id,
  html_url: `https://github.com/${REPO}/issues/${n}#issuecomment-${id}`,
  issue_url: issue(n),
  body,
  user: { login },
  created_at: at,
  updated_at: at,
});

const pull = (number: number, labels: string[], merged_at: string | null = null) => ({
  number,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  title: `Feature ${number}`,
  body: "Adds a <b>thing</b>.",
  user: { login: "cam" },
  created_at: "2026-11-09T17:00:00Z",
  merged_at,
  labels: labels.map((name) => ({ name })),
});

interface Route {
  status: number;
  body?: unknown;
  etag?: string;
}

function fakeFetch(routes: { comments: Route; pulls: Route }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = url.includes("/issues/comments") ? routes.comments : routes.pulls;
    const headers = r.etag ? { etag: r.etag } : undefined;
    return new Response(r.status === 304 ? null : JSON.stringify(r.body ?? []), { status: r.status, headers });
  }) as typeof fetch;
  return { impl, calls };
}

function fakeDispatcher() {
  const jobs: IngestJob[] = [];
  const d: Dispatcher = {
    async dispatch(job) {
      jobs.push(job);
      return { capture_id: job.capture_id, team_id: job.team_id, who: job.who, type: job.type, state: "queued", received_at: job.received_at, raw_ids: [] } satisfies CaptureStatus;
    },
    status: async () => undefined,
    captures: async () => [],
    publish: () => {},
    subscribe: () => () => {},
  };
  return { d, jobs };
}

function setup(routes: { comments: Route; pulls: Route }, store = new MemoryStore()) {
  const f = fakeFetch(routes);
  const { d, jobs } = fakeDispatcher();
  const poller = createGithubPoller({
    repo: REPO,
    team_id: "hh",
    boardIssue: 2,
    intervalMs: 45_000,
    token: "ghp_secret",
    store,
    dispatcher: d,
    fetchImpl: f.impl,
    now: () => NOW,
  });
  return { poller, jobs, calls: f.calls };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("github poller", () => {
  it("classifies board posts, gitar reviews and other comments", async () => {
    const { poller, jobs, calls } = setup({
      comments: {
        status: 200,
        body: [
          comment(1, 2, "jake", "B: capture page landed."),
          comment(2, 7, "gitar-bot", "<p>Looks   good,\n<b>one nit</b></p>"),
          comment(3, 7, "cam", "fixed the nit"),
        ],
      },
      pulls: { status: 200, body: [] },
    });
    await poller.tick();
    expect(jobs.map((j) => [j.capture_id, j.type, j.who, j.text, j.side])).toEqual([
      ["gh-comment-1", "board", "jake", "B: capture page landed.", undefined],
      ["gh-comment-2", "review", "gitar", "Gitar review on PR #7: Looks good, one nit", undefined],
      ["gh-comment-3", "pr", "cam", "Comment on #7: fixed the nit", undefined],
    ]);
    expect(jobs[0]).toMatchObject({ team_id: "hh", at: "2026-11-09T18:00:00Z", received_at: NOW.toISOString() });
    expect(jobs[0]?.source_ref).toContain("#issuecomment-1");
    expect(calls[0]?.url).toContain("since=2026-11-09T00%3A00%3A00.000Z");
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghp_secret");
  });

  it("emits opened and merged PR jobs with deterministic ids and side from labels", async () => {
    const { poller, jobs } = setup({
      comments: { status: 200, body: [] },
      pulls: { status: 200, body: [pull(9, ["stream:B-ui"], "2026-11-09T19:00:00Z"), pull(8, ["stream:A-brain"]), pull(5, [])] },
    });
    await poller.tick();
    expect(jobs.map((j) => [j.capture_id, j.side, j.at])).toEqual([
      ["gh-pr-5-opened", undefined, "2026-11-09T17:00:00Z"],
      ["gh-pr-8-opened", "backend", "2026-11-09T17:00:00Z"],
      ["gh-pr-9-opened", "frontend", "2026-11-09T17:00:00Z"],
      ["gh-pr-9-merged", "frontend", "2026-11-09T19:00:00Z"],
    ]);
    expect(jobs[2]?.text).toBe("PR #9 opened by cam: Feature 9\n\nAdds a thing .");
    expect(jobs[3]?.text).toBe("PR #9 merged: Feature 9");
  });

  it("dispatches nothing on a second tick with the same payload", async () => {
    const { poller, jobs } = setup({
      comments: { status: 200, body: [comment(1, 2, "jake", "hi")] },
      pulls: { status: 200, body: [pull(4, [])] },
    });
    await poller.tick();
    await poller.tick();
    expect(jobs.map((j) => j.capture_id)).toEqual(["gh-comment-1", "gh-pr-4-opened"]);
  });

  it("skips ids already in the store", async () => {
    const store = new MemoryStore();
    await store.indexRaw([
      { team_id: "hh", id: "gh-comment-1:0", capture_id: "gh-comment-1", type: "board", who: "jake", at: "2026-11-09T18:00:00.000Z", seq: 0, text: "hi" },
      { team_id: "hh", id: "gh-pr-4-opened:0", capture_id: "gh-pr-4-opened", type: "pr", who: "cam", at: "2026-11-09T17:00:00.000Z", seq: 0, text: "PR #4" },
    ]);
    const { poller, jobs } = setup(
      { comments: { status: 200, body: [comment(1, 2, "jake", "hi"), comment(2, 2, "cam", "new")] }, pulls: { status: 200, body: [pull(4, [])] } },
      store,
    );
    await poller.tick();
    expect(jobs.map((j) => j.capture_id)).toEqual(["gh-comment-2"]);
  });

  it("seeds from more than one page of the store", async () => {
    const store = new MemoryStore();
    const at = (i: number) => new Date(Date.parse("2026-11-09T01:00:00.000Z") + i * 1000).toISOString();
    await store.indexRaw(
      Array.from({ length: 250 }, (_, i) => ({
        team_id: "hh", id: `gh-comment-${i}:0`, capture_id: `gh-comment-${i}`, type: "pr" as const, who: "cam", at: at(i), seq: 0, text: "x",
      })),
    );
    const spy = vi.spyOn(store, "recent");
    // Comment 0 is the oldest doc: only reachable on the second page.
    const { poller, jobs } = setup({ comments: { status: 200, body: [comment(0, 7, "cam", "old"), comment(250, 7, "cam", "new")] }, pulls: { status: 200, body: [] } }, store);
    await poller.tick();
    expect(jobs.map((j) => j.capture_id)).toEqual(["gh-comment-250"]);
    expect(spy.mock.calls.filter(([p]) => p.type === "pr").map(([p]) => p.before)).toEqual([undefined, at(50), at(0)]);
  });

  it("sends If-None-Match with the last ETag and treats 304 as nothing new", async () => {
    const routes = {
      comments: { status: 200, body: [] as unknown[], etag: 'W/"c1"' },
      pulls: { status: 200, body: [pull(4, [])] as unknown[], etag: 'W/"p1"' },
    };
    const { poller, jobs, calls } = setup(routes);
    await poller.tick();
    routes.comments = { status: 304, body: [], etag: 'W/"c1"' };
    routes.pulls = { status: 304, body: [], etag: 'W/"p1"' };
    await poller.tick();
    expect(calls[0]?.headers["If-None-Match"]).toBeUndefined();
    expect(calls[2]?.headers["If-None-Match"]).toBe('W/"c1"');
    expect(calls[3]?.headers["If-None-Match"]).toBe('W/"p1"');
    expect(jobs).toHaveLength(1);
  });

  it("backs off on 403 without throwing", async () => {
    const { poller, jobs, calls } = setup({ comments: { status: 403 }, pulls: { status: 200, body: [pull(4, [])] } });
    await expect(poller.tick()).resolves.toBeUndefined();
    await poller.tick();
    expect(calls).toHaveLength(1); // pulls skipped, second tick skipped
    expect(jobs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("survives a fetch that throws", async () => {
    const { d } = fakeDispatcher();
    const poller = createGithubPoller({
      repo: REPO, team_id: "hh", boardIssue: 2, intervalMs: 1000, store: new MemoryStore(), dispatcher: d,
      fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch,
    });
    await expect(poller.tick()).resolves.toBeUndefined();
  });
});

describe("createGithubPollerFromEnv", () => {
  const deps = { store: new MemoryStore(), dispatcher: fakeDispatcher().d };
  it("is off for the placeholder, a missing repo, a malformed repo, or GITHUB_POLL=off", () => {
    expect(createGithubPollerFromEnv({ GITHUB_REPO: "owner/hack-harness" }, deps)).toBeUndefined();
    expect(createGithubPollerFromEnv({}, deps)).toBeUndefined();
    expect(createGithubPollerFromEnv({ GITHUB_REPO: "not a repo" }, deps)).toBeUndefined();
    expect(createGithubPollerFromEnv({ GITHUB_REPO: REPO, GITHUB_POLL: "off" }, deps)).toBeUndefined();
  });
  it("is on for a real repo", () => {
    expect(createGithubPollerFromEnv({ GITHUB_REPO: REPO }, deps)?.repo).toBe(REPO);
  });
});
