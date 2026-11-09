/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" swaps the live UI for the labeled sample sessions (AGENTS.md: seed data only behind SEED=true). */
  readonly VITE_SEED?: string
}
