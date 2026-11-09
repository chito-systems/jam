// STUB — replaced by the stream D PR. Signature is fixed; apps/api mounts it at ROUTES.mcp.
import type { ContextStore, Dispatcher } from "@hh/shared";

export interface McpDeps {
  store: ContextStore;
  dispatcher: Dispatcher;
}

/** Handles one MCP streamable-HTTP request. team_id and who come from the URL query. */
export async function handleMcpRequest(_request: Request, _deps: McpDeps): Promise<Response> {
  return Response.json({ error: "mcp not implemented yet" }, { status: 501 });
}
