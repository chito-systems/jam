// The context MCP server: every coding agent on the team reads the same brain through this.
// Stateless streamable HTTP: a fresh McpServer + transport per request, JSON responses, no sessions.
// team_id (required) and who (default "agent") come from the URL query on every request.
import {
  type ContextStore,
  type Dispatcher,
  type ItemDoc,
  ItemKindSchema,
  type RawDoc,
  type SearchHit,
  SourceTypeSchema,
  withSpan,
} from "@hh/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface McpDeps {
  store: ContextStore;
  dispatcher: Dispatcher;
}

interface Caller {
  team_id: string;
  who: string;
}

const QuerySchema = z.object({
  team_id: z.string().min(1).max(64),
  who: z.string().min(1).max(56).default("agent"), // stored as `agent:<who>`, WhoSchema max is 64
});

const jsonError = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { allow: "POST" } });

/** Handles one MCP streamable-HTTP request. team_id and who come from the URL query. */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = QuerySchema.safeParse({
    team_id: params.get("team_id") || undefined,
    who: params.get("who") || undefined,
  });
  if (!query.success) {
    return jsonError(400, "team_id is required: add ?team_id=<team code>&who=<session name> to the MCP url");
  }
  // Stateless: no standalone SSE stream to GET, no session to DELETE.
  if (request.method !== "POST") return jsonError(405, "method not allowed: this MCP server is stateless, POST only");

  const server = buildServer(deps, query.data);
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
  try {
    return await withSpan(`mcp.${name}`, { team_id: caller.team_id, who: caller.who }, fn);
  } catch (err) {
    console.error(`mcp.${name} failed`, { team_id: caller.team_id, who: caller.who, err });
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `${name} failed: ${message}` }], isError: true };
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const fmtRaw = (d: RawDoc) => `${d.at} ${d.who} [${d.type}] ${d.id}\n  ${oneLine(d.text)}`;
const fmtItem = (i: ItemDoc, indent = "") =>
  `${indent}${i.at} ${i.who} [${i.kind}${i.status === "open" ? "" : `, ${i.status}`}] ${i.id}\n${indent}  ${oneLine(i.text)}`;
const fmtHit = (h: SearchHit) =>
  h.layer === "item"
    ? fmtItem(h.doc)
    : [fmtRaw(h.doc), ...h.items.map((i) => fmtItem(i, "    "))].join("\n");

function buildServer(deps: McpDeps, caller: Caller): McpServer {
  const { store, dispatcher } = deps;
  const { team_id } = caller;
  const server = new McpServer({ name: "hack-harness-context", version: "0.1.0" });

  server.registerTool(
    "context_search",
    {
      description:
        "Search everything the team has said, decided or posted today (voice notes, pasted text, Board posts, PRs, reviews, and decisions extracted from them). Call it when you need to know what the humans meant, whether something was already decided, or who owns what, before asking a human. Results: UTC time, who, type, id, text; derived items indented under the raw text they came from.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for, e.g. 'merge queue' or 'decided auth'"),
        who: z.string().min(1).max(64).optional().describe("Only from this speaker, e.g. 'cam' or 'agent:opus-1'"),
        type: SourceTypeSchema.optional().describe("Only this source type"),
        since: z.iso.datetime().optional().describe("Only at or after this UTC ISO time"),
        limit: z.number().int().min(1).max(50).optional().describe("Max hits, default 10"),
      },
    },
    ({ query, who, type, since, limit }) =>
      run("context_search", caller, async () => {
        const res = await store.search({ team_id, q: query, who, type, since, limit: limit ?? 10 });
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
      },
    },
    ({ n, who, type }) =>
      run("context_recent", caller, async () => {
        const docs = await store.recent({ team_id, limit: n ?? 20, who, type });
        if (docs.length === 0) return text("Nothing captured yet for this team.", { docs: [] });
        return text(docs.map(fmtRaw).join("\n\n"), { docs });
      }),
  );

  server.registerTool(
    "context_decisions",
    {
      description:
        "Call this before starting a task, alongside context_recent: decisions the team has made today, newest first. Do not relitigate these; follow them. Superseded decisions are marked.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max decisions, default 50"),
      },
    },
    ({ limit }) =>
      run("context_decisions", caller, async () => {
        const items = await store.items({ team_id, kind: "decision", limit: limit ?? 50 });
        if (items.length === 0) {
          return text(
            'No extracted decisions yet (the librarian that pulls them out of conversations may not be running). Try context_search with query "decided" to find decisions in the raw captures.',
            { items: [] },
          );
        }
        return text(items.map((i) => fmtItem(i)).join("\n\n"), { items });
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
          who: `agent:${caller.who}`,
          type: "text",
          at: now,
          received_at: now,
          source_ref: "mcp",
          text: kind ? `[${kind}] ${body}` : body,
        });
        return text(`Recorded as capture ${status.capture_id} (${status.state}).`, {
          capture_id: status.capture_id,
          state: status.state,
        });
      }),
  );

  return server;
}
