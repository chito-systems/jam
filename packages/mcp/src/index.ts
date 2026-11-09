// The context MCP server: every coding agent on the team reads the same brain through this.
// Stateless streamable HTTP: a fresh McpServer + transport per request, JSON responses, no sessions.
// team_id (required), who (default "agent") and side (optional) come from the URL query on every request.
import {
  acceptTask,
  type ContextStore,
  claimTask,
  closeTask,
  type Dispatcher,
  type ItemDoc,
  ownershipOf,
  humanOf,
  parseRoster,
  type Presence,
  type RosterEntry,
  ItemKindSchema,
  ItemVerdictSchema,
  type RawDoc,
  reportClash,
  type SearchHit,
  setItemVerdict,
  SIDE_PATHS,
  type Side,
  SideSchema,
  SourceTypeSchema,
  type TaskDoc,
  TaskStatusSchema,
  withSpan,
} from "@hh/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface McpDeps {
  store: ContextStore;
  dispatcher: Dispatcher;
  /** Who is on the team right now. Every request marks the caller seen. */
  presence?: Presence;
  /** Defaults to JAM_ROSTER. */
  roster?: RosterEntry[];
}

interface Caller {
  team_id: string;
  who: string;
  side?: Side;
  /** Marks a tool call in presence. */
  onTool?: (tool: string) => void;
}

const QuerySchema = z.object({
  team_id: z.string().min(1).max(64),
  who: z.string().min(1).max(56).default("agent"), // stored as `agent:<who>`, WhoSchema max is 64
  side: SideSchema.optional(),
});

const jsonError = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { allow: "POST" } });

/** Handles one MCP streamable-HTTP request. team_id and who come from the URL query. */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = QuerySchema.safeParse({
    team_id: params.get("team_id") || undefined,
    who: params.get("who") || undefined,
    side: params.get("side") || undefined,
  });
  if (!query.success) {
    if (params.get("team_id") && query.error.issues.some((i) => i.path[0] === "side")) {
      return jsonError(400, "side must be backend or frontend: use &side=backend|frontend in the MCP url");
    }
    return jsonError(400, "team_id is required: add ?team_id=<team code>&who=<session name> to the MCP url");
  }
  // Stateless: no standalone SSE stream to GET, no session to DELETE.
  if (request.method !== "POST") return jsonError(405, "method not allowed: this MCP server is stateless, POST only");

  const { presence } = deps;
  presence?.seen(query.data);
  const onTool = presence ? (tool: string) => presence.seen({ ...query.data, tool }) : undefined;
  const server = buildServer(deps, { ...query.data, onTool });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

const text = (body: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(structured ? { structuredContent: structured } : {}),
});

/** Runs a tool body in a span; any failure becomes an MCP tool error instead of a 500. */
async function run(name: string, caller: Caller, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  caller.onTool?.(name);
  try {
    return await withSpan(`mcp.${name}`, { team_id: caller.team_id, who: caller.who }, fn);
  } catch (err) {
    console.error(`mcp.${name} failed`, { team_id: caller.team_id, who: caller.who, err });
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `${name} failed: ${message}` }], isError: true };
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const fmtRaw = (d: RawDoc) =>
  `${d.at} ${d.who}${d.side ? ` (${d.side})` : ""} [${d.type}] ${d.id}\n  ${oneLine(d.text)}`;
const fmtItem = (i: ItemDoc, indent = "") =>
  `${indent}${i.at} ${i.who} [${i.kind}${i.status === "open" ? "" : `, ${i.status}`}] ${i.id}\n${indent}  ${oneLine(i.text)}`;
/** "[confirmed]" or "[unconfirmed 0.82]": how settled a decision is. */
const grade = (i: ItemDoc) =>
  i.verdict === "confirmed" ? "[confirmed]" : `[unconfirmed${i.confidence === undefined ? "" : ` ${i.confidence.toFixed(2)}`}]`;
const fmtHit = (h: SearchHit) =>
  h.layer === "item"
    ? fmtItem(h.doc)
    : [fmtRaw(h.doc), ...h.items.map((i) => fmtItem(i, "    "))].join("\n");
const fmtPaths = (paths: string[]) => (paths.length > 0 ? paths.join(", ") : "(none yet)");
const fmtTask = (t: TaskDoc) =>
  [
    t.status === "proposed"
      ? `[proposed → ${t.suggested_owner ?? t.side}] ${t.side} · ${t.title}`
      : `[${t.status}] ${t.side} · ${t.owner} · ${t.title}`,
    `  paths: ${fmtPaths(t.paths)}`,
    `  id: ${t.id}${t.pr ? ` · pr: ${t.pr}` : ""}`,
  ].join("\n");
const toolError = (body: string, structured?: Record<string, unknown>): CallToolResult => ({
  ...text(body, structured),
  isError: true,
});
/** "agent:cam-opus-2" -> "cam": the person behind a session name. */
const personOf = (who: string) => who.replace(/^agent:/, "").split("-")[0]?.toLowerCase() ?? "";
/** Proposed work for this session: named for me first, then my side, oldest first. The other side's work never. */
export function nextWork(proposed: TaskDoc[], who: string, side?: Side): TaskDoc[] {
  const me = personOf(who);
  const named = (t: TaskDoc) => t.suggested_owner !== undefined && personOf(t.suggested_owner) === me;
  const oldest = (a: TaskDoc, b: TaskDoc) => a.created_at.localeCompare(b.created_at);
  const mine = proposed.filter(named).sort(oldest);
  const sides = proposed.filter((t) => !named(t) && side !== undefined && t.side === side).sort(oldest);
  return [...mine, ...sides];
}
export const UNNAMED_HINT =
  "Your MCP url has no recognizable name. Re-add it with who=<human>-<model>-<n>, e.g. who=cam-opus-1, so teammates can tell agents apart.";
const TAKE_IT = "To take it: task_accept with this id (add paths if none are listed). If it isn't yours to take, leave it.";
const sideArg = SideSchema.optional().describe("Only from this half of the team: backend or frontend");

function buildServer(deps: McpDeps, caller: Caller): McpServer {
  const { store, dispatcher } = deps;
  const { team_id } = caller;
  const server = new McpServer({ name: "hack-harness-context", version: "0.1.0" });
  const me = `agent:${caller.who}`;

  /** Live feed + a line in the brain for every claim/close. A failed brain write never fails the tool. */
  const announce = async (task: TaskDoc, line: string) => {
    dispatcher.publish(team_id, { event: "task", data: task });
    const now = new Date().toISOString();
    try {
      await dispatcher.dispatch({
        capture_id: crypto.randomUUID(),
        team_id,
        who: me,
        type: "text",
        at: now,
        received_at: now,
        source_ref: `task:${task.id}`,
        side: task.side,
        text: line,
      });
    } catch (err) {
      console.error("mcp.task brain write failed", { team_id, who: me, task_id: task.id, err });
    }
  };

  server.registerTool(
    "whoami",
    {
      description: "Call once at the start of a session. Tells you who you are on this team and what you hold.",
      inputSchema: {},
    },
    () =>
      run("whoami", caller, async () => {
        const human = humanOf(caller.who, deps.roster ?? parseRoster(process.env.JAM_ROSTER));
        const owns = caller.side ? [...SIDE_PATHS[caller.side]] : [];
        const claims = (await store.tasks({ team_id, status: "claimed", limit: 200 })).filter((t) => t.owner === me);
        const lines = [
          `You are ${me} on team ${team_id}.`,
          human ? `You work for ${human}.` : "No human on the roster matches your name.",
          caller.side
            ? `Side: ${caller.side}. That side owns ${owns.join(", ")}.`
            : "No side: add &side=backend|frontend to the MCP url to claim paths.",
          claims.length > 0 ? "You hold:" : "You hold no open claims.",
          ...claims.map((t) => `- ${t.title}: ${t.paths.join(", ")} (task ${t.id})`),
        ];
        if (!human) lines.push("", UNNAMED_HINT);
        return text(lines.join("\n"), {
          id: me,
          ...(human ? { human } : {}),
          ...(caller.side ? { side: caller.side } : {}),
          owns,
          claims: claims.map((t) => ({ id: t.id, title: t.title, paths: t.paths })),
        });
      }),
  );

  server.registerTool(
    "context_search",
    {
      description:
        "Search everything the team has said, decided or posted today (voice notes, pasted text, Board posts, PRs, reviews, and decisions extracted from them). Call it when you need to know what the humans meant, whether something was already decided, or who owns what, before asking a human. Results: UTC time, who, type, id, text; derived items indented under the raw text they came from.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for, e.g. 'merge queue' or 'decided auth'"),
        who: z.string().min(1).max(64).optional().describe("Only from this speaker, e.g. 'cam' or 'agent:opus-1'"),
        type: SourceTypeSchema.optional().describe("Only this source type"),
        side: sideArg,
        since: z.iso.datetime().optional().describe("Only at or after this UTC ISO time"),
        limit: z.number().int().min(1).max(50).optional().describe("Max hits, default 10"),
      },
    },
    ({ query, who, type, side, since, limit }) =>
      run("context_search", caller, async () => {
        const res = await store.search({ team_id, q: query, who, type, side, since, limit: limit ?? 10 });
        if (res.hits.length === 0) return text(`No matches for "${query}".`, { hits: [] });
        return text(res.hits.map(fmtHit).join("\n\n"), { hits: res.hits, mode: res.mode });
      }),
  );

  server.registerTool(
    "context_recent",
    {
      description:
        "Call this before starting a task: the latest things the team said or posted, newest first. Tells you what changed while you were working and what people are focused on right now.",
      inputSchema: {
        n: z.number().int().min(1).max(200).optional().describe("How many entries, default 20"),
        who: z.string().min(1).max(64).optional().describe("Only from this speaker"),
        type: SourceTypeSchema.optional().describe("Only this source type"),
        side: sideArg,
      },
    },
    ({ n, who, type, side }) =>
      run("context_recent", caller, async () => {
        const docs = await store.recent({ team_id, limit: n ?? 20, who, type, side });
        if (docs.length === 0) return text("Nothing captured yet for this team.", { docs: [] });
        return text(docs.map(fmtRaw).join("\n\n"), { docs });
      }),
  );

  server.registerTool(
    "context_decisions",
    {
      description:
        "Call this before starting a task, alongside context_recent: decisions the team has made today, newest first. Do not relitigate these; follow them. Superseded decisions are marked. Each line is [confirmed] by a human or [unconfirmed <librarian confidence>]: unconfirmed items are the librarian's reading of the conversation, not settled fact.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max decisions, default 50"),
      },
    },
    ({ limit }) =>
      run("context_decisions", caller, async () => {
        const all = await store.items({ team_id, kind: "decision", limit: limit ?? 50 });
        const items = all.filter((i) => i.verdict !== "rejected");
        if (items.length === 0) {
          return text(
            'No extracted decisions yet (the librarian that pulls them out of conversations may not be running). Try context_search with query "decided" to find decisions in the raw captures.',
            { items: [] },
          );
        }
        return text(items.map((i) => `${grade(i)} ${fmtItem(i)}`).join("\n\n"), { items });
      }),
  );

  server.registerTool(
    "item_verdict",
    {
      description:
        "Confirm or reject an item the librarian extracted (a decision, todo, ...). Only call when a human on your team told you to confirm or reject an item. Rejected items leave the decision log.",
      inputSchema: {
        id: z.string().min(1).describe("The item id, as shown by context_decisions or context_search"),
        verdict: ItemVerdictSchema.describe("confirmed or rejected"),
      },
    },
    ({ id, verdict }) =>
      run("item_verdict", caller, async () => {
        const item = await setItemVerdict(store, { team_id, id, who: me, verdict });
        if (!item) return toolError(`No item ${id} on team ${team_id}. Check the id with context_decisions.`);
        dispatcher.publish(team_id, { event: "item", data: item });
        return text(`Item ${item.id} ${verdict} by ${me}: ${oneLine(item.text)}`, { item });
      }),
  );

  server.registerTool(
    "context_add",
    {
      description:
        "When you make a non-obvious choice, record it in one sentence so the humans and every other agent see it (e.g. 'Chose X over Y because Z'). Also for blockers and open questions. Not for progress logs. Returns the capture id.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe("One sentence"),
        kind: ItemKindSchema.optional().describe("What this is, e.g. decision, blocker, question"),
      },
    },
    ({ text: body, kind }) =>
      run("context_add", caller, async () => {
        const now = new Date().toISOString();
        const status = await dispatcher.dispatch({
          capture_id: crypto.randomUUID(),
          team_id,
          who: me,
          type: "text",
          at: now,
          received_at: now,
          source_ref: "mcp",
          side: caller.side,
          text: kind ? `[${kind}] ${body}` : body,
        });
        return text(`Recorded as capture ${status.capture_id} (${status.state}).`, {
          capture_id: status.capture_id,
          state: status.state,
        });
      }),
  );

  server.registerTool(
    "task_claim",
    {
      description:
        "Call this BEFORE editing any file. Declares which files or directories you are about to change. Refused if another agent holds them or they belong to the other side of the team; if refused, do not edit those paths. Call task_done when your PR is open.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("What you are doing, e.g. 'Add /api/stats route'"),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe("Repo-relative files or directories you will edit, e.g. ['apps/api/src/routes/']"),
      },
    },
    ({ title, paths }) =>
      run("task_claim", caller, async () => {
        const { side } = caller;
        if (!side) {
          return toolError(
            "This session has no side, so it cannot claim paths. Ask the user to add &side=backend|frontend to the MCP url and reconnect.",
          );
        }
        const res = await claimTask(store, { team_id, who: me, side, title, paths });
        if (!res.ok) {
          await reportClash(dispatcher, { team_id, who: me, side, conflict: res.conflict });
          const lines = res.conflict.conflicts.map(
            (t) => `- ${t.owner}: "${t.title}" holds ${t.paths.join(", ")} (task ${t.id})`,
          );
          return toolError([`Refused: ${res.conflict.error}`, ...lines].join("\n"), { conflict: res.conflict });
        }
        const { task } = res;
        await announce(task, `[task claimed] ${task.title} — ${task.owner} is editing ${task.paths.join(", ")}`);
        return text(
          `Claimed task ${task.id}, you hold ${task.paths.join(", ")}. Call task_done with id ${task.id} when your PR is open (or released: true if you abandon it).`,
          { task },
        );
      }),
  );

  server.registerTool(
    "task_next",
    {
      description:
        "Call when you have no assigned work, or when a human says to pick up the next thing. Returns the best open work order for your side with its full build prompt.",
      inputSchema: {},
    },
    () =>
      run("task_next", caller, async () => {
        const proposed = await store.tasks({ team_id, status: "proposed", limit: 200 });
        const [task] = nextWork(proposed, caller.who, caller.side);
        if (!task) return text("No proposed work for your side.", { task: null });
        return text(
          [
            `Work order: ${task.title}`,
            `id: ${task.id}`,
            `proposed paths: ${fmtPaths(task.paths)}`,
            `why you: ${task.reason ?? "(no reason given)"}`,
            "",
            task.spec ?? "(no build prompt)",
            "",
            TAKE_IT,
          ].join("\n"),
          { task },
        );
      }),
  );

  server.registerTool(
    "task_accept",
    {
      description:
        "Take a proposed work order. Only call after a human told you to, or when the work order names you.",
      inputSchema: {
        id: z.string().min(1).describe("The work order id, from task_next or task_list"),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .optional()
          .describe("Repo-relative files or directories you will edit. Defaults to the proposed paths"),
      },
    },
    ({ id, paths }) =>
      run("task_accept", caller, async () => {
        const res = await acceptTask(store, id, { team_id, who: me, side: caller.side, paths });
        if (!res.ok) {
          if ("notFound" in res) return toolError(`No task ${id} on team ${team_id}. Check the id with task_list.`);
          if ("error" in res) return toolError(`Refused: ${res.error}`);
          await reportClash(dispatcher, { team_id, who: me, side: caller.side, conflict: res.conflict });
          const lines = res.conflict.conflicts.map(
            (t) => `- ${t.owner}: "${t.title}" holds ${t.paths.join(", ")} (task ${t.id})`,
          );
          return toolError([`Refused: ${res.conflict.error}`, ...lines].join("\n"), { conflict: res.conflict });
        }
        const { task } = res;
        await announce(
          task,
          `[task accepted] ${task.title} — ${task.owner} took the work order jam proposed and is editing ${task.paths.join(", ")}`,
        );
        return text(
          [
            `Accepted task ${task.id}, you hold ${task.paths.join(", ")}.`,
            "",
            task.spec ?? "(no build prompt)",
            "",
            `Call task_done with id ${task.id} when your PR is open (or released: true if you abandon it).`,
          ].join("\n"),
          { task },
        );
      }),
  );

  server.registerTool(
    "task_done",
    {
      description:
        "Call when your PR is open, or when you abandon the work (released: true). Frees the paths for other agents.",
      inputSchema: {
        id: z.string().min(1).describe("The task id task_claim returned"),
        pr: z.string().optional().describe("PR number or url"),
        note: z.string().max(500).optional().describe("One line on how it ended"),
        released: z.boolean().optional().describe("true if you abandoned the work instead of finishing it"),
      },
    },
    ({ id, pr, note, released }) =>
      run("task_done", caller, async () => {
        const status = released ? "released" : "done";
        const task = await closeTask(store, id, { team_id, who: me, status, pr, note });
        if (!task) return toolError(`No task ${id} on team ${team_id}. Check the id with task_list.`);
        await announce(
          task,
          `[task ${status}] ${task.title} — ${task.owner} freed ${task.paths.join(", ")}${task.pr ? ` (PR ${task.pr})` : ""}`,
        );
        return text(`Task ${task.id} ${status}. Freed ${task.paths.join(", ")}.`, { task });
      }),
  );

  server.registerTool(
    "who_owns",
    {
      description:
        "Call before planning an edit to see which side owns a file, who its captain is, and whether another agent is working on it right now.",
      inputSchema: {
        path: z.string().min(1).describe("Repo-relative file or directory, e.g. 'apps/api/src/app.ts'"),
      },
    },
    ({ path }) =>
      run("who_owns", caller, async () => {
        const own = await ownershipOf(store, { team_id, path, roster: parseRoster(process.env.JAM_ROSTER) });
        const lines = [
          own.side
            ? `${own.path}: ${own.side} side, captain ${own.captain ?? "(none on the roster)"}`
            : `${own.path}: shared ground, anyone may claim it`,
          ...own.held_by.map((t) => `held by ${t.owner}: "${t.title}" (task ${t.id})`),
          ...own.proposed.map((t) => `proposed: "${t.title}" (work order ${t.id})`),
        ];
        if (own.held_by.length === 0 && own.proposed.length === 0) lines.push("nobody is working on it right now");
        return text(lines.join("\n"), { ...own });
      }),
  );

  server.registerTool(
    "task_list",
    {
      description: "See who is working on what right now. Call before planning work, so you pick paths nobody holds.",
      inputSchema: {
        status: TaskStatusSchema.optional().describe(
          "Default: claimed (open work) and proposed (work orders nobody has taken). done or released for history",
        ),
        side: SideSchema.optional().describe("Only backend or frontend tasks"),
      },
    },
    ({ status, side }) =>
      run("task_list", caller, async () => {
        const wants = status ? [status] : (["claimed", "proposed"] as const);
        const lists = await Promise.all(wants.map((s) => store.tasks({ team_id, status: s, side, limit: 200 })));
        const tasks = lists.flat();
        if (tasks.length === 0) {
          return text(status ? `No ${status} tasks.` : "No open claims or proposed work.", { tasks: [] });
        }
        return text(tasks.map(fmtTask).join("\n\n"), { tasks });
      }),
  );

  return server;
}
