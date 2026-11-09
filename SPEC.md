# JAM — Agent Development Environment (ADE)

**Problem (one sentence):** In an agent-era hackathon, a team's context fragments across people, agents, voice conversations and PRs within an hour, and the humans lose focus trying to hold it together.

**Product (one sentence):** JAM is an open-source ADE that gives a hackathon team one shared, searchable context brain (Elasticsearch), one safe merge path for humans and agents (Gitar + merge queue), and a focus-first interface for the human while agents work.

> **What changed since this was written (4:10 PM).** This is the morning spec, kept as written. The merge path shipped as PR → Gitar → CI → merge (no merge queue: GitHub does not offer it on a personally-owned repository; Gitar auto-apply off). Board and PR ingestion is a poller. We entered Elasticsearch, Gitar and Radar, not Dash0; OpenTelemetry is implemented but off. JAM is live at https://jam.cnh.radarhq.io. The README describes what shipped.

**Built for:** this hackathon, today, by a team using it to build itself. Generalizes to any team building with agents.

## Three pillars (pitch order)

### 1. Shared context brain — Elasticsearch (core data layer)
- One-key voice capture (local Whisper-class model, CPU) → transcript → indexed in Elasticsearch within seconds, tagged `who`, `when`, `topic`, `source`.
- Everything the team produces is indexed: voice notes, board posts, PR descriptions, Gitar review comments, decisions, README. Any file type can be dropped in.
- Hybrid search (BM25 + vector via `semantic_text`, RRF) over all of it: "what did Jake say about the merge queue?" "why did we pick Hono?"
- Every agent on the team gets the same context via an MCP tool (`context.search`, `context.recent`, `context.decisions`). Agents stop diverging because they read the same brain.
- Context expires with the hackathon unless exported.

### 2. Safe merging for humans + agents — Gitar (+ GitHub)
- Every change is a PR. Gitar reviews against `.gitar/review/` conventions. Auto-apply fixes CI.
- Merge queue: PRs that pass Gitar + CI are merged in order by the designated merge agent. Humans see the queue in the ADE.
- Ownership table in AGENTS.md (stream, label, owner, scope) stops agents editing the same files.
- Board: pinned GitHub Issue #2 is the team channel; agents post and tag; it's indexed into the brain too.

### 3. Focus-first interface — the "brainrot IDE"
- One window: panes for Brain (search + recent context), Board, Merge queue, Agents (what each agent is doing now), Clock (deadline countdown).
- Feed pane: a vertical swipe feed of *your own project's* signal — new transcripts, PRs landing, Gitar comments, board posts, talk cards from the conference schedule. The dopamine hit comes from your team's progress, not someone else's app.
- Voice button is the primary input. Talk, it's captured, everyone's agents know.
- Monaco editor pane for NOW.md / pitch / notes, saved via PR.

## Sponsor tracks
| Track | Role in JAM |
| --- | --- |
| Elasticsearch | The brain. Core data layer. Hybrid search + RAG for agents. |
| Sonar / Gitar | The merge path. Every PR reviewed; review instructions; auto-apply; the merge queue is built around Gitar's verdict. |
| Radar | JAM is deployed on the Radar cluster via Argo CD; the Agents pane reads workload health via Radar MCP; one AI investigation on a real issue in the README. |
| Dash0 | Every agent run and every voice→index pipeline step is traced (OpenTelemetry + OpenLIT). Agents pane shows token cost per agent. SLO: transcript indexed within 10 s, p95. Chaos toggle on the indexing worker. |
| Merge Forward | Voice-first input and a focus mode are accessibility features; say so. |

## Architecture
- One TypeScript repo. `apps/web` (ADE UI, Vite + React), `apps/api` (Hono), `apps/worker` (transcription + indexing + agent runs), `packages/mcp` (context MCP server for agents).
- Elastic Cloud trial (external). Indices: `context` (all captured items), `decisions`.
- Voice: browser mic → chunked upload → worker runs local Whisper-class model → text → Elastic. If local model is slow on the cluster, use OpenAI Whisper API with the $50 credits; same interface.
- Agents: Claude Code sessions on laptops, connected to `packages/mcp` for context and to Radar MCP for deploys. No custom agent runtime today.
- Deployed to `team-<name>` namespace on Radar's cluster. Single Deployment for web+api, one for worker. Requests/limits set. Readiness probes.

## Scope knife
- **By 1:00 (skeleton):** voice → transcript → Elastic → searchable in the UI. Deployed. Board pane reading Issue #2. Gitar installed, PRs flowing.
- **By 3:00:** MCP context server used by your own agents. Merge queue view. Agents pane via Radar. OTel into Dash0.
- **By 4:30:** Feed pane, Monaco pane, SLO + chaos, polish. Freeze.
- **Cut first if behind:** Monaco pane → Feed pane → Agents pane. Never cut: voice→brain→search, Gitar PR flow, deployed on Radar.

## What we don't build today
- A custom agent runtime or harness. We orchestrate Claude Code; the harness is the MCP + rules + merge queue.
- Any outreach automation (LinkedIn, email). Rule 4.
- Accounts/auth beyond a team code.

## Demo (90 s)
1. Problem, 10 s: "Four people, twelve agents, one afternoon. Context fragments in an hour. We built the environment we needed at 11:00 this morning and used it all day."
2. Press the voice key, say a decision. Watch it land in the brain, tagged. Ask an agent a question that only that voice note answers.
3. Show the merge queue: today's PRs, Gitar's comments, one it auto-fixed.
4. Flip chaos on the indexer. Dash0 goes red; Agent0 explains; Radar investigation agrees.
5. "Everything you just saw was built through itself. Repo's public."

## AI disclosure
Claude Code (Fable, Opus, Sonnet) wrote most of the code under AGENTS.md rules; every change via Gitar-reviewed PR; humans designed, reviewed, merged, and can explain any file.
