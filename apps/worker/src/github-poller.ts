// Pulls the repo's own activity (Board posts, PRs, Gitar reviews) into the brain by polling GitHub's REST API.
// Polling, not webhooks: no public URL needed. Every new thing becomes one IngestJob with a deterministic id.
import { type ContextStore, type Dispatcher, type IngestJob, type Side, type SourceType, withSpan } from "@hh/shared";

type FetchImpl = typeof fetch;

const API = "https://api.github.com";
const BACKOFF_MS = 5 * 60_000;
const TYPES: SourceType[] = ["board", "pr", "review"];

export interface GithubPollerOptions {
  repo: string;
  team_id: string;
  boardIssue: number;
  intervalMs: number;
  token?: string;
  store: ContextStore;
  dispatcher: Dispatcher;
  fetchImpl?: FetchImpl;
  now?: () => Date;
}

export interface GithubPoller {
  readonly repo: string;
  start(): void;
  stop(): void;
  /** One poll. Never throws. */
  tick(): Promise<void>;
}

interface GhComment {
  id: number;
  html_url: string;
  issue_url: string;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  merged_at: string | null;
  labels: Array<{ name: string }>;
}

const clean = (s: string, max: number) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export function sideFromLabels(labels: Array<{ name: string }>): Side | undefined {
  const names = labels.map((l) => l.name);
  if (names.includes("stream:B-ui")) return "frontend";
  if (names.some((n) => n.startsWith("stream:"))) return "backend";
  return undefined;
}

type Draft = Pick<IngestJob, "capture_id" | "type" | "who" | "at" | "source_ref" | "side" | "text">;

export function commentToDraft(c: GhComment, boardIssue: number): Draft | undefined {
  const login = c.user?.login ?? "unknown";
  const n = Number(c.issue_url.split("/").pop());
  const base = { capture_id: `gh-comment-${c.id}`, at: c.created_at, source_ref: c.html_url };
  if (n === boardIssue) {
    const text = (c.body ?? "").trim();
    return text ? { ...base, type: "board", who: login, text } : undefined;
  }
  if (login.toLowerCase().startsWith("gitar")) {
    const text = clean(c.body ?? "", 1500);
    return text ? { ...base, type: "review", who: "gitar", text: `Gitar review on PR #${n}: ${text}` } : undefined;
  }
  const text = (c.body ?? "").trim();
  return text ? { ...base, type: "pr", who: login, text: `Comment on #${n}: ${text}` } : undefined;
}

export function pullToDrafts(p: GhPull): Draft[] {
  const login = p.user?.login ?? "unknown";
  const side = sideFromLabels(p.labels ?? []);
  const body = clean(p.body ?? "", 800);
  const out: Draft[] = [
    {
      capture_id: `gh-pr-${p.number}-opened`,
      type: "pr",
      who: login,
      at: p.created_at,
      source_ref: p.html_url,
      side,
      text: `PR #${p.number} opened by ${login}: ${p.title}${body ? `\n\n${body}` : ""}`,
    },
  ];
  if (p.merged_at) {
    out.push({
      capture_id: `gh-pr-${p.number}-merged`,
      type: "pr",
      who: login,
      at: p.merged_at,
      source_ref: p.html_url,
      side,
      text: `PR #${p.number} merged: ${p.title}`,
    });
  }
  return out;
}

export function createGithubPoller(opts: GithubPollerOptions): GithubPoller {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const backfillFrom = startOfUtcDay(now());
  const etags = new Map<string, string>();
  const seen = new Set<string>();
  let seeded = false;
  let since = backfillFrom;
  let backoffUntil = 0;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const seed = async () => {
    for (const type of TYPES) {
      const docs = await opts.store.recent({ team_id: opts.team_id, type, limit: 200 });
      for (const d of docs) seen.add(d.capture_id);
    }
    seeded = true;
  };

  /** Returns the parsed body, or undefined for 304 / error / backoff. */
  const get = async <T>(path: string): Promise<T | undefined> => {
    const url = `${API}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hack-harness-poller",
    };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const etag = etags.get(url);
    if (etag) headers["If-None-Match"] = etag;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 304) return undefined;
    if (res.status === 403 || res.status === 429) {
      backoffUntil = now().getTime() + BACKOFF_MS;
      console.error(`github poller: ${res.status} from GitHub, backing off 5 minutes`, { repo: opts.repo });
      return undefined;
    }
    if (!res.ok) {
      console.error("github poller: request failed", { repo: opts.repo, path, status: res.status });
      return undefined;
    }
    const tag = res.headers.get("etag");
    if (tag) etags.set(url, tag);
    return (await res.json()) as T;
  };

  const dispatch = async (draft: Draft) => {
    if (seen.has(draft.capture_id) || draft.at < backfillFrom) return 0;
    await opts.dispatcher.dispatch({ ...draft, team_id: opts.team_id, received_at: now().toISOString() });
    seen.add(draft.capture_id);
    return 1;
  };

  const poll = () =>
    withSpan("github.poll", { repo: opts.repo, team_id: opts.team_id }, async (span) => {
      if (!seeded) await seed();
      let dispatched = 0;
      const q = `since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100`;
      const comments = await get<GhComment[]>(`/repos/${opts.repo}/issues/comments?${q}`);
      for (const c of comments ?? []) {
        const draft = commentToDraft(c, opts.boardIssue);
        if (draft) dispatched += await dispatch(draft);
        if (c.updated_at > since) since = c.updated_at; // after dispatch: a failure retries next tick
      }
      if (now().getTime() < backoffUntil) return;
      const pulls = await get<GhPull[]>(`/repos/${opts.repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`);
      // Oldest first so the feed reads in order.
      for (const p of [...(pulls ?? [])].reverse()) {
        for (const draft of pullToDrafts(p)) dispatched += await dispatch(draft);
      }
      span.setAttribute("dispatched", dispatched);
    });

  const tick = async () => {
    if (running || now().getTime() < backoffUntil) return;
    running = true;
    try {
      await poll();
    } catch (err) {
      console.error("github poller: tick failed", {
        repo: opts.repo,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  return {
    repo: opts.repo,
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), opts.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** A poller when GITHUB_REPO is a real `owner/name` and GITHUB_POLL isn't "off"; otherwise undefined. */
export function createGithubPollerFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { store: ContextStore; dispatcher: Dispatcher; fetchImpl?: FetchImpl },
): GithubPoller | undefined {
  const repo = env.GITHUB_REPO?.trim() ?? "";
  if ((env.GITHUB_POLL ?? "").trim().toLowerCase() === "off") return undefined;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo === "owner/hack-harness") return undefined;
  const seconds = Number(env.GITHUB_POLL_SECONDS);
  const board = Number(env.GITHUB_BOARD_ISSUE);
  return createGithubPoller({
    repo,
    team_id: env.GITHUB_TEAM_ID?.trim() || "hh",
    boardIssue: Number.isInteger(board) && board > 0 ? board : 2,
    intervalMs: (Number.isFinite(seconds) && seconds >= 5 ? seconds : 45) * 1000,
    token: env.GITHUB_TOKEN?.trim() || undefined,
    ...deps,
  });
}
