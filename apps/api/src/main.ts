// Wiring only. Behavior lives in app.ts.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createStoreFromEnv } from "@hh/shared";
import { createInlineDispatcher, createTranscriberFromEnv } from "@hh/worker";
import { createApp } from "./app";

const store = createStoreFromEnv(process.env);
const transcriber = createTranscriberFromEnv(process.env);
const dispatcher = createInlineDispatcher({
  store,
  transcriber,
  chaos: process.env.CHAOS_MODE === "true",
});

const distPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
const webDist = existsSync(distPath) ? distPath : undefined;

try {
  await store.ensureReady();
} catch (err) {
  // Keep serving: /readyz reports 503 until the store is reachable.
  console.error(`store.ensureReady failed (store=${store.constructor.name}); serving anyway:`, err);
}

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);
serve({ fetch: createApp({ store, dispatcher, webDist }).fetch, port }, (info) => {
  console.log(
    `api listening on :${info.port} store=${store.constructor.name} transcriber=${transcriber?.name ?? "none"} chaos=${process.env.CHAOS_MODE === "true"} web=${webDist ?? "none"}`,
  );
});
