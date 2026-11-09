# NOW.md — one screen, always current

Agents: read on start. Humans: update when something changes. Live status lives on the Board (Issue #2); this file is the pitch, the decisions, and the clock.

## Pitch (one sentence)
JAM is an open-source Agent Development Environment for hackathon teams: one shared context brain, one safe merge path for humans and agents, one focus-first interface.

## The narrow problem for v0
Capture what the team says, make it searchable in under 10 seconds, give every agent the same context through one MCP tool.

## Decisions (see PROJECT.md for why)
- Data layer: Elasticsearch on Elastic Cloud, indices `context_raw` (immutable truth) + `context_items` (librarian layer)
- Capture: mobile web page `/capture`, hold-to-record, Whisper API via OpenAI credits; local model later
- Agents read via `packages/mcp` (context_search / context_recent / context_decisions / context_add)
- Merge path: PR → Gitar → CI → merge on `main` (no merge queue: not offered on a personally-owned repo)
- Deploy: Radar cluster, Argo CD from the `deploy` branch (main + image tag), GHCR images, namespace `team-jam`, live at https://jam.cnh.radarhq.io
- Observability: OTel implemented but off (no Dash0 track). SLO "transcript searchable < 10 s" shown in the product; chaos flag on indexer
- Contract: `packages/shared/src/types.ts`. API under `/api/*`, MCP at `/mcp`. `STORE=memory` runs the API with no credentials.
- Sides: backend = Cam (streams A, C, D), frontend = Jake (stream B). One Fable orchestrator per side merges. See AGENTS.md.
- Stack: TS monorepo — apps/web (Vite+React), apps/api (Hono), apps/worker, packages/mcp, packages/shared
- IP: owned jointly by Cam and Jake, 50/50. Agreed ___ (time)

## Checkpoints
- [x] 12:15 — text in, text searchable (deployed on cluster at 3:17)
- [x] 1:00 — voice in, searchable < 10 s. START USING IT. (1:09)
- [x] 2:00 — MCP live; GitHub poller instead of a webhook; OTel built but off (no Dash0 track)
- [x] 3:00 — librarian (jam), grading, work orders, delegator, workspace UI
- [x] 4:00 — SLO + chaos; Radar Checks reviewed, two findings fixed in #57
- [ ] 4:30 — FREEZE. README, disclosure, backup demo video
- [ ] 5:15 — submitted

## Links
- Repo: https://github.com/chito-systems/jam
- Live app: https://jam.cnh.radarhq.io (cluster `jam`, namespace `team-jam`)
- Elastic Cloud: ___
- Dash0: ___
- Radar Cloud: ___
- Gitar: ___
- Board: Issue #2
- Team code in the app: `hh`

## Credits at kickoff
- Cam Claude: ___   Jake Claude: ___   OpenAI codes: Cam ___ Jake ___

## Demo script (fill by 4:00)
1. 
2. 
3. 
4. 

## People met today (name · working on · follow up?)
- 
