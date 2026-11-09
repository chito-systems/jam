// STUB — the stream A ElasticStore PR replaces the body. Signature is fixed.
import { type ContextStore, MemoryStore } from "./store";

/**
 * STORE=memory -> MemoryStore (tests, no-credential laptops).
 * STORE=elastic, or STORE unset with ELASTIC_URL set -> ElasticStore.
 * STORE=elastic without ELASTIC_URL must throw: the cluster never falls back to memory.
 */
export function createStoreFromEnv(_env: NodeJS.ProcessEnv): ContextStore {
  return new MemoryStore();
}
