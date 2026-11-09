# NOW.md — one screen, always current

Agents: read on start. Humans: update when something changes. Live status lives on the Board (Issue #1); this file is the pitch, the decisions, and the clock.

## Pitch (one sentence)
Hack Harness is an open-source Agent Development Environment for hackathon teams: one shared context brain, one safe merge path for humans and agents, one focus-first interface.

## The narrow problem for v0
Capture what the team says, make it searchable in under 10 seconds, give every agent the same context through one MCP tool.

## Decisions (see PROJECT.md for why)
- Data layer: Elasticsearch on Elastic Cloud, indices `context_raw` (immutable truth) + `context_items` (librarian layer)
- Capture: mobile web page `/capture`, hold-to-record, Whisper API via OpenAI credits; local model later
- Agents read via `packages/mcp` (context_search / context_recent / context_decisions / context_add)
- Merge path: PRs → Gitar → CI → GitHub merge queue on `main`
- Deploy: Radar cluster, Argo CD from `main`, GHCR images, namespace `team-___`
- Observability: OTel → Dash0, SLO "transcript searchable < 10 s p95", chaos flag on indexer
- Stack: TS monorepo — apps/web (Vite+React), apps/api (Hono), apps/worker, packages/mcp, packages/shared
- IP: owned jointly by Cam and Jake, 50/50. Agreed ___ (time)

## Checkpoints
- [ ] 12:15 — text in, text searchable, deployed on cluster
- [ ] 1:00 — voice in, searchable < 10 s. START USING IT.
- [ ] 2:00 — MCP on both laptops; webhook ingest; OTel in Dash0
- [ ] 3:00 — librarian; /brain UI designed; merge queue pane
- [ ] 4:00 — SLO + chaos; Radar investigation done and screenshotted
- [ ] 4:30 — FREEZE. README, disclosure, backup demo video
- [ ] 5:15 — submitted

## Links
- Repo: ___
- Live app: https://___.cnh.radarhq.io
- Elastic Cloud: ___
- Dash0: ___
- Radar Cloud: ___
- Gitar: ___
- Board: Issue #1

## Credits at kickoff
- Cam Claude: ___   Jake Claude: ___   OpenAI codes: Cam ___ Jake ___

## Demo script (fill by 4:00)
1. 
2. 
3. 
4. 

## People met today (name · working on · follow up?)
- 
