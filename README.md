# Hack Harness

An open-source **Agent Development Environment** for hackathon teams. One shared context brain, one safe merge path for humans and agents, one focus-first interface.

Built in one day at the [Cloud Native Hackathon](https://www.wemakedevs.org/hackathons/cnh), Salt Lake City, November 9, 2026, by Cam Hess and Jake ___. We used it to build itself.

## The problem
In an agent-era hackathon, a team's context fragments across people, agents, voice conversations and PRs within an hour. Agents diverge because each has a different slice of the truth. Humans burn out holding it together.

## What it does
- **Shared brain.** Hold a key, talk. Transcribed and indexed in Elasticsearch in seconds, tagged with who and when. Board posts, PR descriptions and review comments flow in through the same pipe. Hybrid search across all of it.
- **Same context for every agent.** An MCP server gives every coding agent on the team `context_search`, `context_recent`, `context_decisions`, `context_add`.
- **Safe merging.** Every change is a PR reviewed by Gitar, landed through a merge queue. Stream ownership keeps agents off each other's files.
- **Focus-first interface.** One window: brain, board, merge queue, agents, clock. <!-- update at 4:00 with what actually shipped -->

## Architecture
<!-- diagram + one paragraph at 4:00 -->

- **Runs on:** Kubernetes (Radar's hackathon cluster, namespace `team-___`), deployed by Argo CD from `main`, images built by GitHub Actions to GHCR.
- **Data layer:** Elasticsearch (Elastic Cloud). `context_raw` is the immutable truth; `context_items` is the librarian agent's structured layer. `semantic_text` fields, hybrid BM25 + kNN with RRF.
- **Observability:** OpenTelemetry traces across upload → transcribe → index → librarian into Dash0; OpenLIT on LLM calls. SLO: transcript searchable within 10 s, p95.
- **Delivery:** Gitar reviews every PR against `.gitar/review/instructions.md`; GitHub merge queue on `main`.

## Tracks entered
| Track | How the tool is used |
| --- | --- |
| Elasticsearch · Find the Right Talk | Core data layer: all team context, hybrid search, RAG for agents |
| Sonar · Never Merge Broken | Every PR reviewed by Gitar; review instructions and stream rules; auto-apply on CI |
| Radar · AI SRE | Deployed and operated on Radar's cluster; see "What broke" |
| Dash0 · Stop Flying Blind | End-to-end ingest traces, agent token cost, SLO, chaos toggle |
| Merge Forward | Voice-first input and focus mode as accessibility features |

## What broke, and what found it
<!-- real incidents from the day, with Radar investigation + Agent0 screenshots and PR links -->

## Running it locally
```bash
pnpm install
cp .env.example .env     # fill in Elastic + OpenAI + OTel
pnpm dev                 # web :5173, api :3000
# no credentials? STORE=memory pnpm dev:api
```
<!-- verify on a clean clone at 4:00 -->

## Running it on Kubernetes
<!-- argocd/application.yaml, Secrets to create, how to point at Elastic and Dash0 -->

## Open-source components
<!-- list libraries/models used with licenses, e.g. transcription -->

## AI disclosure
Built with AI coding assistants, disclosed per hackathon rule 5. Claude Code (Fable 5.1, Opus, Sonnet) wrote most of the code under the rules in `AGENTS.md`: every change shipped as a pull request, reviewed by Gitar and by a human, merged through the queue. Cam and Jake designed the product and architecture, chose every tool, wrote the agent rules and review instructions, reviewed every merge, and can explain any file in this repo. Each PR states which tools wrote it. From 1:00 PM the team's own conversations were captured into the brain and used by our agents to build this.

## What we'd do next
<!-- one honest paragraph -->

## License
MIT. Copyright 2026 Cam Hess and Jake ___.
