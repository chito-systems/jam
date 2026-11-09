// Wiring only. Behavior lives in app.ts.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createStoreFromEnv } from "@hh/shared";
import {
  createGithubPollerFromEnv,
  createInlineDispatcher,
  createLibrarianFromEnv,
  createTranscriberFromEnv,
} from "@hh/worker";
import { createApp } from "./app";

const store = createStoreFromEnv(process.env);
const transcriber = createTranscriberFromEnv(process.env);
const librarian = createLibrarianFromEnv(process.env);
const dispatcher = createInlineDispatcher({
  store,
  transcriber,
  librarian,
  chaos: process.env.CHAOS_MODE === "true",
});
const github = createGithubPollerFromEnv(process.env, { store, dispatcher });

const distPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
const webDist = existsSync(distPath) ? distPath : undefined;

try {
  await store.ensureReady();
} catch (err) {
  // Keep serving: /readyz reports 503 until the store is reachable.
  console.error(`store.ensureReady failed (store=${store.constructor.name}); serving anyway:`, err);
}

github?.start(); // first tick runs after ensureReady, so the seen-set seeds from a ready store

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);
serve({ fetch: createApp({ store, dispatcher, webDist }).fetch, port }, (info) => {
  console.log(
    `api listening on :${info.port} store=${store.constructor.name} transcriber=${transcriber?.name ?? "none"} librarian=${librarian?.name ?? "none"} chaos=${process.env.CHAOS_MODE === "true"} web=${webDist ?? "none"} github=${github?.repo ?? "off"}`,
  );
});
