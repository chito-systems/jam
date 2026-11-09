// The HTTP API. All behavior lives here so tests can drive it with app.request().
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { handleMcpRequest } from "@hh/mcp";
import {
  type ApiError,
  type ContextStore,
  type Dispatcher,
  type IngestJob,
  type IngestResponse,
  IngestTextRequestSchema,
  IngestUploadFieldsSchema,
  ItemsParamsSchema,
  type ItemsResponse,
  createPresence,
  type Presence,
  RecentParamsSchema,
  type RecentResponse,
  ROUTES,
  SearchParamsSchema,
  withSpan,
} from "@hh/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { matchedRoutes } from "hono/route";
import { streamSSE } from "hono/streaming";
import { registerAgentRoutes } from "./agents-routes";
import { CAPTURE_PAGE_HTML } from "./capture-page";
import { type ChaosSwitch, createChaosSwitch, registerChaosRoutes } from "./chaos-routes";
import { registerDecisionRoutes } from "./decisions-routes";
import { registerItemRoutes } from "./items-routes";
import { registerOwnershipRoutes } from "./ownership-routes";
import { registerTaskRoutes } from "./tasks-routes";

export interface AppDeps {
  store: ContextStore;
  dispatcher: Dispatcher;
  /** Absolute path to the built web app (apps/web/dist). Served with an SPA fallback when set. */
  webDist?: string;
  /** The live chaos switch (shared with the pipeline). Defaults to a fresh one, off. */
  chaos?: ChaosSwitch;
  /** False when env CHAOS_SWITCH=off: POST /api/chaos then returns 403. Default true. */
  allowChaosSwitch?: boolean;
  /** Which agents are on the team. Shared by the MCP mount and /api/agents. Defaults to a fresh one. */
  presence?: Presence;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const RESERVED_PREFIXES = ["/api/", "/mcp", "/c", "/healthz", "/readyz"];

type Span = Parameters<Parameters<typeof withSpan>[2]>[0];
type Env = { Variables: { span: Span } };

const apiError = (error: string, detail?: unknown): ApiError =>
  detail === undefined ? { error } : { error, detail };

const isReserved = (path: string) =>
  RESERVED_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));

/** Parses a query string or body with a zod schema; on failure returns a 400 Response instead of data. */
// Structural so apps/api needs no direct zod dependency; every schema comes from @hh/shared.
interface Schema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

function parse<T>(c: Context<Env>, schema: Schema<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data };
  return { res: c.json(apiError("invalid request", result.error.issues), 400) };
}

const isMediaMime = (mime: string) => mime.startsWith("audio/") || mime.startsWith("video/");

/** Audio iff the mime says so, or the mime is unknown and the client explicitly said voice. */
export const isAudioUpload = (mime: string, type: string) =>
  isMediaMime(mime) || ((mime === "" || mime === "application/octet-stream") && type === "voice");

export function createApp(deps: AppDeps): Hono<Env> {
  const { store, dispatcher } = deps;
  const chaos = deps.chaos ?? createChaosSwitch(false);
  const presence = deps.presence ?? createPresence();
  const app = new Hono<Env>();

  // One span per request, named by the matched route pattern (not the raw path: low cardinality).
  app.use("*", (c, next) => {
    const route =
      matchedRoutes(c)
        .map((r) => r.path)
        .find((p) => p !== "*" && p !== "/*" && !p.endsWith("/*")) ?? "*";
    const teamId = c.req.query("team_id");
    const attributes = {
      "http.method": c.req.method,
      "http.route": route,
      ...(teamId ? { team_id: teamId } : {}),
    };
    return withSpan(`api ${c.req.method} ${route}`, attributes, async (span) => {
      c.set("span", span);
      await next();
      span.setAttribute("http.status_code", c.res.status);
    });
  });

  app.use("/api/*", cors());
  app.use(ROUTES.mcp, cors());

  app.onError((err, c) => {
    console.error(`api error ${c.req.method} ${c.req.path}:`, err);
    return c.json(apiError("internal error", err.message), 500);
  });

  app.notFound((c) => c.json(apiError("not found"), 404));

  app.post(
    ROUTES.ingest,
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) => c.json(apiError(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`), 413),
    }),
    async (c) => {
      const received_at = new Date().toISOString();
      const capture_id = crypto.randomUUID();
      const contentType = c.req.header("content-type") ?? "";
      let job: IngestJob;

      if (contentType.startsWith("application/json")) {
        let raw: unknown;
        try {
          raw = await c.req.json();
        } catch (err) {
          return c.json(apiError("body is not valid JSON", String(err)), 400);
        }
        const parsed = parse(c, IngestTextRequestSchema, raw);
        if (parsed.res) return parsed.res;
        const body = parsed.data;
        job = { ...body, capture_id, received_at, at: body.at ?? received_at };
      } else if (contentType.startsWith("multipart/form-data")) {
        const form = await c.req.parseBody();
        const file = form.file;
        const fields = Object.fromEntries(
          Object.entries(form).filter((e): e is [string, string] => typeof e[1] === "string"),
        );
        const parsed = parse(c, IngestUploadFieldsSchema, fields);
        if (parsed.res) return parsed.res;
        if (!(file instanceof File)) return c.json(apiError("missing `file` part"), 400);
        if (file.size > MAX_UPLOAD_BYTES) {
          return c.json(apiError(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`), 413);
        }
        const body = parsed.data;
        const base = { ...body, capture_id, received_at, at: body.at ?? received_at };
        const mime = file.type;
        if (isAudioUpload(mime, body.type)) {
          const audioMime = mime || "application/octet-stream";
          const data = new Uint8Array(await file.arrayBuffer());
          job = { ...base, audio: { data, mime: audioMime, filename: file.name || undefined } };
        } else {
          const text = await file.text();
          if (!text.trim()) return c.json(apiError("uploaded text file is empty"), 400);
          // A text file is never voice (`voice` is the schema default for uploads).
          const type = body.type === "voice" ? "file" : body.type;
          job = { ...base, type, text, source_ref: body.source_ref ?? file.name };
        }
      } else {
        return c.json(apiError("content-type must be application/json or multipart/form-data"), 415);
      }

      c.get("span").setAttributes({ team_id: job.team_id, capture_id, "capture.type": job.type });
      const status = await dispatcher.dispatch(job);
      const res: IngestResponse = { capture_id: status.capture_id, state: status.state };
      return c.json(res, 202);
    },
  );

  app.get(ROUTES.capture, async (c) => {
    const status = await dispatcher.status(c.req.param("id"));
    if (!status) return c.json(apiError("capture not found"), 404);
    return c.json(status);
  });

  app.get(ROUTES.search, async (c) => {
    const parsed = parse(c, SearchParamsSchema, c.req.query());
    if (parsed.res) return parsed.res;
    return c.json(await store.search(parsed.data));
  });

  app.get(ROUTES.recent, async (c) => {
    const parsed = parse(c, RecentParamsSchema, c.req.query());
    if (parsed.res) return parsed.res;
    const res: RecentResponse = { docs: await store.recent(parsed.data) };
    return c.json(res);
  });

  app.get(ROUTES.items, async (c) => {
    const parsed = parse(c, ItemsParamsSchema, c.req.query());
    if (parsed.res) return parsed.res;
    const res: ItemsResponse = { items: await store.items(parsed.data) };
    return c.json(res);
  });

  app.get(ROUTES.events, (c) => {
    const parsed = parse(c, RecentParamsSchema.pick({ team_id: true }), c.req.query());
    if (parsed.res) return parsed.res;
    const { team_id } = parsed.data;
    return streamSSE(c, async (stream) => {
      const write = (event: string, data: string) =>
        stream.writeSSE({ event, data }).catch((err: unknown) => {
          console.error(`sse write failed team_id=${team_id} event=${event}:`, err);
        });
      const unsubscribe = dispatcher.subscribe(team_id, (ev) => {
        void write(ev.event, JSON.stringify(ev.data));
      });
      const heartbeat = setInterval(() => {
        void write("ping", JSON.stringify({ at: new Date().toISOString() }));
      }, HEARTBEAT_MS);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  registerTaskRoutes(app, { store, dispatcher, chaos });
  registerChaosRoutes(app, { dispatcher, chaos, allowSwitch: deps.allowChaosSwitch ?? true });
  registerDecisionRoutes(app, { store });
  registerItemRoutes(app, { store, dispatcher });
  registerOwnershipRoutes(app, { store });
  registerAgentRoutes(app, { store, presence });

  app.all(ROUTES.mcp, (c) => handleMcpRequest(c.req.raw, { store, dispatcher, presence }));

  app.get("/c", (c) => c.html(CAPTURE_PAGE_HTML));

  app.get(ROUTES.healthz, (c) => c.json({ ok: true, version: process.env.APP_VERSION ?? "dev" }));

  app.get(ROUTES.readyz, async (c) => {
    const ok = await store.ping().catch((err: unknown) => {
      console.error("readyz: store.ping failed:", err);
      return false;
    });
    return c.json({ ok }, ok ? 200 : 503);
  });

  if (deps.webDist) {
    const root = deps.webDist;
    app.get("*", serveStatic({ root }), (c, next) => {
      if (isReserved(c.req.path)) return next();
      return serveStatic({ path: join(root, "index.html") })(c, next);
    });
  }

  return app;
}
