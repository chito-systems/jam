# PROJECT.md — Hack Harness (ADE)

Read AGENTS.md first, then this, then NOW.md. This file holds the problem, the architecture decisions, and the build order. Decisions here are made; don't relitigate them in a PR.

## The narrow problem
A hackathon team's context (what was said, decided, tried) fragments across people, agents, voice conversations and PRs within an hour. Agents then diverge because each one has a different slice of the truth.

**v0 solves exactly this:** capture conversation from any person on the team, make it searchable in seconds, and give every agent the same context through one tool. Nothing else until that works end to end.

## Architecture decisions (final for today)

| Decision | Choice | Why |
| --- | --- | --- |
| Where shared context lives | **Elasticsearch on Elastic Cloud** (trial), two indices | It's the data layer the Elastic track judges on; external so it doesn't eat the 2 CPU / 4 GiB cluster budget. Not Sonar (that's review), not "in Kubernetes" (the app runs there, the data doesn't). |
| Team scoping | One `team_id` on every document; team code typed once on the capture page, stored in localStorage | No auth today. Judges can be given the code. |
| Capture surface | **Mobile web page** at `/capture`: one big record button, team code, your name. Also accepts file upload (voice memos) and pasted text | Works on any phone in 5 seconds; this is what you use walking around today. |
| Transcription | **OpenAI Whisper API** behind an interface `Transcriber`; local model (whisper.cpp / faster-whisper in the worker) is a drop-in later if time | Fastest path to working by 1:00. $50 credits cover the day. |
| Storage model | **Deterministic first, agent second.** Raw transcript chunks are stored verbatim and are the source of truth. An async "librarian" agent then extracts structured items that link back to raw chunk ids | If the agent is wrong you still have the truth. Search hits both layers. |
| Ingest | One endpoint `POST /ingest` for every source type: `voice`, `text`, `file`, `board`, `pr`, `review`. Everything becomes a `context_raw` doc | One pipeline, many sources. Board posts and PR descriptions are pulled by a GitHub webhook → same endpoint. |
| How agents read it | **MCP server** (`packages/mcp`) with tools: `context_search(query, who?, type?, since?)`, `context_recent(n)`, `context_decisions()`, `context_add(text, type)` | Every Claude Code session on the team adds this MCP once. Same brain for all. |
| Merge path | GitHub PRs, Gitar review, CI, merge queue (GitHub's native merge queue on `main`); the ADE shows the queue | Sonar track. Gitar verdicts are also ingested into the brain. |
| Runtime | TypeScript monorepo. `apps/web` (Vite + React), `apps/api` (Hono), `apps/worker` (transcribe + index + librarian), `packages/mcp`, `packages/shared` (types, ES client) | One language, one Dockerfile per app, agents are fluent. |
| Deploy | Radar's cluster, `team-<name>` namespace, Argo CD from `main`, images via GitHub Actions → GHCR (all from the cnh-starter) | Radar track. |
| Observability | OpenTelemetry in api and worker → Dash0. Trace every ingest end to end: upload → transcribe → index → librarian. OpenLIT on LLM calls. SLO: "transcript searchable within 10 s, p95" | Dash0 track; the pipeline is the natural thing to trace and to break. |
| Chaos | `CHAOS_MODE=true` adds 3 s latency + 20% failures in the worker's index step | The demo moment for Agent0 and Radar. Off by default. |

## Data model

### Index `context_raw` — the truth
```json
{
  "team_id": "keyword",
  "id": "keyword",
  "type": "keyword",            // voice | text | file | board | pr | review
  "who": "keyword",             // cam | jake | gitar | agent:opus-1 ...
  "at": "date",
  "source_ref": "keyword",      // file name, issue comment url, PR number
  "seq": "integer",             // chunk order within a recording
  "text": "semantic_text",      // the transcript / content chunk; embeds on ingest
  "duration_s": "float"
}
```
Voice is chunked per utterance (Whisper segments) or every ~30 s, whichever is smaller. Never edited after write.

### Index `context_items` — the librarian's layer
```json
{
  "team_id": "keyword",
  "id": "keyword",
  "kind": "keyword",            // decision | question | todo | person | idea | blocker | fact
  "text": "semantic_text",      // one clean sentence
  "who": "keyword",
  "at": "date",
  "tags": "keyword[]",
  "raw_ids": "keyword[]",       // links back to context_raw
  "status": "keyword"           // open | done | superseded (for todo/question)
}
```
The librarian runs after each ingest batch: reads the new raw chunks plus the last 20 items, emits new items or marks old ones superseded. It is allowed to be wrong; raw is the truth.

### Search
Hybrid query (BM25 on `text` + kNN via `semantic_text`, RRF) over both indices, filtered by `team_id`, optional `who`/`type`/`since`. Return raw chunk + any items derived from it.

## Request flow
1. Phone: hold the button → MediaRecorder captures webm/opus → on release, `POST /ingest` (multipart, `type=voice`, `who`, `team_id`).
2. API: writes a job to the worker queue (Redis if cheap; else a Postgres-free in-process queue in the worker fed by an HTTP call), returns `202 {job_id}`.
3. Worker: `Transcriber.transcribe(audio)` → segments → bulk index `context_raw` → enqueue librarian for this batch → emit spans the whole way.
4. Librarian: LLM call with the batch + recent items → bulk index `context_items`.
5. UI `/brain`: search box, recent feed, filters by who/type. Polls or SSE for new items.
6. Agents: `context_search("what did we decide about the merge queue")` → ranked raw + items.

## Build order (today)
1. **11:30–12:15** Repo from cnh-starter, monorepo scaffold, Elastic indices created by a script, `/ingest` for `type=text`, `/search`. Deploy. *Text in, text searchable, on the cluster.*
2. **12:15–1:00** `/capture` page with record button, Whisper transcription in the worker, chunks indexed. *Voice in, searchable in <10 s.* Start using it. Everything you and Jake say from here goes in.
3. **1:00–2:00** MCP server; both laptops add it to Claude Code; agents start reading the brain. GitHub webhook → board posts and PRs ingested. OTel → Dash0.
4. **2:00–3:00** Librarian. `/brain` UI with Jake's design. Merge queue pane.
5. **3:00–4:00** Dash0 SLO + chaos toggle. Radar investigation on a real issue (there will be one). Feed/swipe pane if time.
6. **4:00–4:30** Freeze. README, disclosure, architecture. Record backup demo.
7. **4:30–5:15** Rehearse ×3. Submit by 5:15.

## Cut order if behind
Feed pane → merge queue pane → librarian (keep raw search only) → webhook ingest. Never cut: voice→raw→search, MCP, deployed on Radar, Gitar PRs.

## Later (not today, but say it in the pitch as "next")
- "Hackathon setup" prompt: paste the sponsor list; an agent researches each sponsor's docs and seeds the brain.
- Local transcription model in the worker (whisper.cpp) so audio never leaves the cluster. The DGX Spark answer.
- Export the brain as a markdown decision log at submission time.
