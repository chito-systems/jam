# JAM

**Where a team's context lives when half the team is agents.** Talk, and every coding agent on the team knows within ten seconds. Say a todo out loud, and it comes back as a build prompt assigned to the right person.

Built in one day at the [Cloud Native Hackathon](https://www.wemakedevs.org/hackathons/cnh), Salt Lake City, November 9, 2026, by Cam Hess and Jake Davis. We used it to build itself: the decisions, reviews and task claims from today are in its own database.

- Live: https://jam.cnh.radarhq.io
- Rules both agent teams followed: [`AGENTS.md`](AGENTS.md) · The contract between them: [`packages/shared/src/types.ts`](packages/shared/src/types.ts)

## Who did what
- **Cam Hess and Jake Davis** chose the problem, the product and its three pillars; chose every sponsor tool and the role it plays; and set the architecture decisions in [`PROJECT.md`](PROJECT.md) before code was written: Elasticsearch as the only data layer, raw-first immutable storage with an LLM layer on top, one ingest path, MCP as the agent interface, a PR-only `main` with an AI reviewer, GitOps to the Radar cluster. They split the work into a backend side (Cam) and a frontend side (Jake), and directed every feature during the day in their own words, many of which are in JAM's own brain: the delegation system, backend/frontend tagging, grading jam's output with a human verdict, work orders and the rule that a named person gets the work, agent identities, the workspace layout, the desktop app.
- **Claude Code** implemented those decisions. It worked out the detailed design inside them (the contract types, module boundaries, prompts) and wrote the code and tests, one pull request per task, under the rules in [`AGENTS.md`](AGENTS.md).
- **OpenAI models** run inside the product. **Gitar** reviewed the pull requests.
- The humans reviewed what shipped by using it all afternoon. Each pull request states which tools wrote it.

## The problem
Two people, a dozen coding agents, six hours. Within an hour nobody, human or agent, has the same picture of what was decided. Agents build the wrong thing confidently, two of them edit the same file, and the humans become the message bus.

Git versions the code. Nothing versions the conversation that caused the code.

## What JAM does

```mermaid
flowchart LR
  V[Voice or text<br/>phone, laptop] --> API[API<br/>Hono, one process]
  GH[GitHub<br/>Board, PRs, Gitar reviews] -->|poller| API
  API --> T[Transcribe<br/>Whisper]
  T --> ES[(Elasticsearch<br/>raw · items · tasks)]
  ES --> J[jam<br/>extract, grade, draft work orders]
  J --> ES
  ES --> UI[Workspace UI]
  ES --> MCP[MCP server]
  MCP --> A1[Coding agents<br/>backend]
  MCP --> A2[Coding agents<br/>frontend]
```

1. **Capture.** Hold a button and talk, or paste text. The recording is transcribed, cut into chunks, and written to Elasticsearch. Each capture reports how long it took to become searchable; the target is under 10 seconds. Board posts, pull requests and review comments flow in through a poller.
2. **Search.** Hybrid keyword + semantic search over everything the team said and did. "Why does gitops not write to the primary branch" finds the note about Argo CD tracking a deploy branch, with almost no words in common.
3. **Extract and grade.** After each capture, *jam* (an LLM pass) pulls out decisions, todos and questions. Each item links to the transcript chunks it came from and carries jam's own confidence score. A person can confirm or reject any item. The transcript is never edited; jam's layer is allowed to be wrong, and the quote is always attached.
4. **Turn talk into work.** For a confident todo, jam drafts a work order: a build prompt with the team's own words quoted, acceptance criteria, the files it expects to touch, and a suggested owner with the reason. Assignment is plain rules, checked in order: someone was named; else the files all belong to one side; else the speaker's side; else a captain decides. Nothing starts until a person accepts.
5. **Keep agents off each other.** Before editing, an agent claims the paths it will touch. A claim is refused if the path belongs to the other half of the team, or if another agent already holds it; the refusal names the holder, and both sides see the clash.
6. **Give every agent the same brain.** One MCP server exposes all of it: `context_search`, `context_recent`, `context_decisions`, `context_add`, `task_next`, `task_accept`, `task_claim`, `task_done`, `task_list`, `who_owns`, `item_verdict`.
7. **Receipts.** `GET /api/decisions.md` renders the day's decisions, each quoting who said what and when.
8. **Agents have identities.** Each agent connects under its own name (`cam-opus-1`), so the workspace shows who is who, whose agent it is, and which files it holds.
9. **Terminals inside the workspace.** One terminal tab per agent in the centre pane, next to the feed.
10. **Ship view.** Today's pull requests and Gitar's reviews of them, ingested from GitHub into the same brain.
11. **A native desktop app** (`desktop/`), described below.

There is no custom agent runtime. The harness is one MCP server, one rules file, and a reviewer on every pull request.

## Architecture
One TypeScript monorepo (pnpm).

| Path | What it is |
| --- | --- |
| `apps/api` | Hono HTTP API. Also serves the web app and the MCP endpoint. |
| `apps/worker` | The ingest pipeline (transcribe → chunk → index), jam's extractor and planner, the GitHub poller. Runs inside the API process today. |
| `apps/web` | The workspace UI (Vite + React). |
| `packages/shared` | The contract (`types.ts`), the Elasticsearch store, the delegation and assignment rules. |
| `packages/mcp` | The MCP server. |
| `deploy/`, `argocd/`, `Dockerfile` | One image, one Deployment, Argo CD application. |

Design choices we can defend:
- **Raw first, agent second.** Transcript chunks are the source of truth and are written create-only, so the database itself rejects an edit. Everything an LLM produces is a separate layer that points back at raw chunk ids.
- **Deterministic before generative.** Chunking, ownership, overlap checks and assignment are plain code. The LLM writes summaries and specs, and never decides who may edit what.
- **One contract file.** Frontend and backend were built by two separate agent teams against `packages/shared/src/types.ts`. Contract changes land in their own pull request.
- **One replica, on purpose.** Capture status and the live feed are held in process memory. Splitting the worker into its own Deployment is the next step, and the `Dispatcher` interface is already the seam for it.

## How JAM uses each sponsor tool

### Elasticsearch: the product's data layer
JAM is, underneath, a set of Elasticsearch indices and the queries over them. Code: [`packages/shared/src/elastic.ts`](packages/shared/src/elastic.ts).

**Where the data lives.** One Elastic Cloud Serverless project, three indices. Nothing else stores data: no Postgres, no Redis.
- `context_raw`: transcript chunks and ingested text, exactly as captured. Immutable.
- `context_items`: what jam extracted (decisions, todos, questions), each pointing back at its raw chunk ids, with jam's confidence and a human's verdict.
- `context_tasks`: file claims and work orders.

**Mappings.** Every mapping is `dynamic: "strict"`, so a misspelled field is a write error, not a silent new field. Each text field is a BM25 `text` field that copies itself into a `semantic_text` field:
```ts
text: { type: "text", copy_to: "text_semantic" },
text_semantic: { type: "semantic_text" },
```
Elasticsearch embeds `text_semantic` on ingest through its own inference service (the live cluster reports `jina-embeddings-v5-text-small`, 1024 dimensions). We run no embedding service. Why two fields: a `match` query on a `semantic_text` field is already semantic, so one field cannot give you both keyword and semantic matching.

**Search is one request.** An RRF retriever over a keyword query and a semantic query, across raw chunks and items together, with the same filters (team, person, type, side, since) on both:
```ts
retriever: { rrf: { rank_window_size: 50, retrievers: [
  { standard: { query: { bool: { must: [{ match: { text: q } }], filter } } } },
  { standard: { query: { bool: { must: [{ semantic: { field: "text_semantic", query: q } }], filter } } } },
] } }
```
One follow-up query then attaches extracted items to the raw chunks they came from (a `terms` filter on `raw_ids`). If the inference endpoint is unavailable, search falls back to keyword-only and the response says `mode: "keyword"`.

A real example of semantic recall: the query "why does gitops not write to the primary branch" returned the note "Argo CD tracks a separate deploy branch because the merge queue rejects direct pushes to main."

**Immutability is enforced by the write, not by convention.** Raw chunks are written with a bulk `create` action, so a second write to an existing id is rejected with a 409 and the store throws:
```ts
operations: docs.flatMap((doc) => [{ create: { _index: index, _id: doc.id } }, doc]),
```

**"Searchable in X s" is an honest number.** Writes use `refresh: "wait_for"`, so the clock stops when the document is visible to search. Measured today at roughly 4 to 6 seconds for voice and text, against a 10 second target.

**What else reads Elasticsearch.**
- The decision log: items, plus their raw quotes fetched by id.
- The delegator's overlap check: open claims in `context_tasks`. Claims are written with `wait_for` too, so the very next claim sees them.
- The dashboard counts: `terms` aggregations by person, type and side.
- The Ship view: `pr` and `review` documents ingested from GitHub.
- Every MCP tool an agent calls.

**Evolving a strict mapping on a live index.** `ensureReady` creates any missing index; for an existing one it sends `putMapping` with the current plain fields, so fields added during the day (for example `side` on raw chunks) appear without a reindex. It leaves the `semantic_text` field alone.

### Radar (Skyhook): where it runs
JAM runs in Radar's hackathon cluster `jam`, namespace `team-jam`, at https://jam.cnh.radarhq.io. One Deployment, one pod: the API, which also serves the workspace and the MCP endpoint. Data lives outside the cluster in Elastic Cloud.
- **GitOps, with `main` kept clean.** Every merge to `main` builds an image tagged with the commit SHA (GitHub Actions → GHCR) and advances a `deploy` branch that Argo CD syncs. The starter template commits the tag straight to `main`; ours goes to a branch that is `main` plus one line, so `main` only ever receives reviewed pull requests.
- **First rollout:** the Secret was created by hand, the Argo CD Application applied once, and the cluster went from the starter page to JAM in under a minute (`/healthz` reports the running commit, which is how a deploy is verified).
- **Manifests** set requests and limits (well inside the team budget), readiness, liveness and startup probes, and run the image as a non-root user.
- **What Radar found, and what we changed.** Once JAM was running we opened Radar's Checks on the cluster. Two findings were ours: the pod had a writable root filesystem, and it mounted a service account token it never uses. We fixed both in one pull request (#57): `readOnlyRootFilesystem: true` with an `emptyDir` for `/tmp`, and `automountServiceAccountToken: false`. We tested the image read-only on a laptop first, merged, and Argo CD rolled it out; the pod came back healthy. One finding we left on purpose: "single replica". Capture status and the live feed are in process memory today, so a second replica would give inconsistent answers until the worker is split out.

### Gitar (Sonar): a review on every pull request
Gitar was installed on the repository around 1:30 PM (its first comment is at 20:30 UTC, on #21) and reviewed every pull request after that, against our own rules in [`.gitar/review/instructions.md`](.gitar/review/instructions.md). At the time of writing, 61 pull requests have been merged and 39 carry a Gitar comment. Every finding was answered on the PR: fixed, or declined with a reason. Things it caught that would have bitten us:
- **#23**: our agent docs still said to wait for a deploy commit on `main` after we moved it to a `deploy` branch. An agent following them would have waited forever.
- **#25**: after a restart the GitHub poller would re-ingest older items and fill the feed with failures.
- **#26**: the decision log could report an existing source as "not found" past a size cap.
- **#30**: a human's confirm/reject could be overwritten if jam's model call was in flight.
- **#39**: two people accepting the same work order at the same moment both succeeded.
- **#48**: the in-memory registry of connected agents could grow without bound, one entry per team code anyone sent. Fixed with a cap and stalest-first eviction.
- **#50**: the markdown renderer could loop forever on certain invisible line-separator characters (U+2028, U+2029) in a transcript. Fixed, with tests for those characters and a 5,000-line hostile input.

Gitar's reviews are themselves ingested into JAM and shown in the workspace's Ship view, so an agent can search what the reviewer said. It repeatedly flagged pull requests over our own 300-line limit; where we kept them whole we said why on the PR. Limits, plainly: there is no GitHub merge queue (it is not offered on a personally-owned repository), so merges were gated on CI and Gitar; and Gitar's auto-apply was off.

### Conferences for everyone (Merge Forward)
Capture is voice-first: no typing, no account, works one-handed on a phone, and the page says out loud when the browser has refused the microphone. Hold-to-talk is also the consent model; nothing records unless someone is holding the button.

## What broke today, and what found it
- **The first real voice note failed.** Chrome's recordings were rejected by the transcription API as undecodable; a synthesized test clip had passed. Found by using it. Fix: re-encode with ffmpeg and retry (#22).
- **Silence became a Korean news sign-off.** A known speech-model hallucination landed in the brain as if someone had said it. Fix: drop segments the model flags as non-speech (#42). The bad chunk is still there, because raw is immutable.
- **jam logged the same decision twice**, the second time from a status post about something else. That is why items now carry a confidence score and a confirm/reject control (#30).
- **The dashboard's p95 read 12.2 s** against a 10 s target, because the GitHub poller's first backfill queued 59 items at once. The number now counts only things a person said (#31).
- **The delegator refused its own orchestrator.** A claim for the next task was rejected because the previous agent's claim on the same files had not been closed. Working as designed.
- **The scaffold sat in a subfolder**, so CI and review rules did nothing until it was moved to the repository root (#1).

## Run it as a desktop app
The native app (`desktop/`, Electron) is a thin shell around the hosted JAM: its own Dock icon and window, the microphone allowed for JAM only, and the terminal bridge started for you when it runs from a clone. The UI updates with every deploy; `Cmd+R` picks it up, no reinstall.
```bash
cd desktop && npm install && npm start            # run it
npm run package && open out/JAM-darwin-arm64/JAM.app   # or build JAM.app (Apple Silicon)
JAM_URL=http://localhost:3000 npm start           # point it at a local server
```
The first launch asks for microphone access; click Allow. `desktop/` has its own npm lockfile and sits outside the pnpm workspace.

No install at all: the Docker launcher runs the whole of JAM locally. Needs Docker. No clone, no Node:
```bash
curl -fsSL https://raw.githubusercontent.com/chito-systems/jam/main/scripts/jam-desktop.sh | bash
```
That pulls the published image, starts JAM on `localhost:8787`, and opens it in its own window. With no credentials it runs in an in-memory demo mode; put `ELASTIC_URL`, `ELASTIC_API_KEY` and `OPENAI_API_KEY` in a `.env` in the folder you run it from to use your own brain. From a clone: `./scripts/jam-desktop.sh` · `--update` pulls the newest build · `--hosted` opens the team's hosted JAM in an app window instead · `--stop` stops it. The web app is also installable from the browser (Chrome: *Install JAM*), which gives the same window and updates itself on every deploy.

## Running it locally
```bash
pnpm install
cp .env.example .env     # ELASTIC_URL, ELASTIC_API_KEY, OPENAI_API_KEY
pnpm dev                 # api on :3000, serving the built web app if present
# no credentials? STORE=memory pnpm dev:api   (keyword search only, nothing persists)
pnpm check               # typecheck, lint, tests: what CI runs
```
Add the brain to a Claude Code session:
```bash
claude mcp add jam --scope user --transport http "http://localhost:3000/mcp?team_id=<team code>&who=<name>&side=backend"
```
Or start a session that is already connected, under its own name, so the workspace can tell agents apart:
```bash
./scripts/jam-agent.sh cam-opus-1 backend     # <human>-<model>-<n>
```
A zero-design capture page is at `/c`; the workspace is at `/`.

## Running it on Kubernetes
`scripts/setup.sh <team>` fills in the namespace. Create the Secret `hack-harness-env` by hand (see [`deploy/RADAR.md`](deploy/RADAR.md)); it is never committed. Apply `argocd/application.yaml` once. After that, merging to `main` deploys.

## What doesn't work yet
- No authentication. A team code scopes the data and that is all.
- Voice and text are sent to OpenAI for transcription and extraction. A local model behind the same `Transcriber` interface is the next step.
- Claims never expire and any teammate can close anyone's task.
- The live feed and capture status are in memory, so the API runs as a single replica.
- OpenTelemetry traces, metrics and logs are implemented and tested against a local collector (#37), but no backend is configured, so they are off.

## What we'd do next
A phone app is in progress: the same hold-to-talk capture, in your pocket. `jam init`: stamp out this repository's setup (rules file, sides, review instructions, CI, contract) for a new team in one command, run by a human captain. Then take the same capture button to the conference itself: a conference is the densest context a developer gets all year, and almost none of it survives the flight home.

## Open-source components
Hono, Zod, `@elastic/elasticsearch`, `@modelcontextprotocol/sdk`, OpenTelemetry JS, Vite, React, Vitest, Biome, tsx (all MIT or Apache-2.0). ffmpeg is installed in the image as a system package (LGPL/GPL, used unmodified as a separate binary). Kubernetes manifests and the deploy workflow started from Radar's `cnh-starter`.

## AI disclosure
Built with AI coding assistants, disclosed per the hackathon rules. Cam and Jake made the product and architecture decisions (see "Who did what" above and [`PROJECT.md`](PROJECT.md)), chose the tools and wrote the rules, and directed every feature. Claude Code did the detailed design and the implementation inside those decisions: one orchestrator session per side (Claude Fable) turned the humans' direction into the contract types and task briefs and merged; Claude Opus subagents implemented one brief per pull request. OpenAI models run inside the product (Whisper for transcription, `gpt-5.4-mini` for extraction and work orders). Gitar reviewed the pull requests. The humans reviewed what shipped by using it all afternoon. Each pull request states which tools wrote it.

## License
MIT. Copyright 2026 Cam Hess and Jake Davis.
