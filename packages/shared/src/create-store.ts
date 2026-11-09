import { Client } from "@elastic/elasticsearch";
import { ElasticStore } from "./elastic";
import { type ContextStore, MemoryStore } from "./store";

/**
 * STORE=memory -> MemoryStore (tests, no-credential laptops).
 * STORE=elastic, or STORE unset with ELASTIC_URL set -> ElasticStore.
 * STORE=elastic without ELASTIC_URL must throw: the cluster never falls back to memory.
 */
export function createStoreFromEnv(env: NodeJS.ProcessEnv): ContextStore {
  const store = env.STORE || (env.ELASTIC_URL ? "elastic" : "memory");
  if (store === "memory") return new MemoryStore();
  if (store !== "elastic") throw new Error(`STORE must be "memory" or "elastic", got "${store}"`);
  if (!env.ELASTIC_URL) throw new Error("STORE=elastic requires ELASTIC_URL");

  const mode = env.ELASTIC_SERVER_MODE;
  if (mode && mode !== "stack" && mode !== "serverless") {
    throw new Error(`ELASTIC_SERVER_MODE must be "stack" or "serverless", got "${mode}"`);
  }
  const serverMode = mode === "stack" || mode === "serverless" ? mode : undefined;
  const client = new Client({
    node: env.ELASTIC_URL,
    ...(env.ELASTIC_API_KEY ? { auth: { apiKey: env.ELASTIC_API_KEY } } : {}),
    ...(serverMode ? { serverMode } : {}),
  });
  return new ElasticStore(client, {
    rawIndex: env.ELASTIC_INDEX_RAW || "context_raw",
    itemsIndex: env.ELASTIC_INDEX_ITEMS || "context_items",
    tasksIndex: env.ELASTIC_INDEX_TASKS || "context_tasks",
    ...(env.ELASTIC_INFERENCE_ID ? { inferenceId: env.ELASTIC_INFERENCE_ID } : {}),
  });
}
