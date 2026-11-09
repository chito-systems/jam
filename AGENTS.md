# AGENTS.md — Hack Harness

Rules for every coding agent and human in this repo. Read order: this file → PROJECT.md → NOW.md → Issue #2 (the Board). The pitch lives in PITCH.md. Keep this file short.

## Context
- Cloud Native Hackathon, Salt Lake City, 2026-11-09. Submission deadline **5:30 PM MT**. Freeze at 4:30.
- We are building Hack Harness, an Agent Development Environment for hackathon teams: shared context brain (Elasticsearch), safe merging for humans + agents (Gitar + merge queue), focus-first interface. PROJECT.md has the architecture; SPEC.md has the pitch.
- We use this product to build itself. From the moment `/capture` works, team conversations go into the brain and agents read it via the `context` MCP server.
- Judges read the repo. Write PRs you'd be proud to explain out loud.

## Two sides, four streams (don't edit outside your side)
| Side | Human | Orchestrator | Streams | Owns |
| --- | --- | --- | --- | --- |
| **Backend** | Cam (`@chito-systems`) | Fable session on Cam's laptop | A · Brain `stream:A-brain`, C · Platform `stream:C-platform`, D · MCP `stream:D-mcp` | `apps/api/`, `apps/worker/`, `packages/shared/`, `packages/mcp/`, `Dockerfile*`, `deploy/`, `argocd/`, `.github/`, `scripts/`, root config (`package.json`, `pnpm-*.yaml`, `tsconfig.base.json`, `biome.json`) |
| **Frontend** | Jake (`@quakeob`) | Fable session on Jake's laptop | B · UI `stream:B-ui` | `apps/web/` — everything in it, including its `package.json` |

Shared docs: `PITCH.md` (anyone, add under your own heading, never rewrite someone else's lines), `NOW.md` (orchestrators only), `PROJECT.md` / `SPEC.md` / `AGENTS.md` (change in a docs-only PR, tag the other human).

### The seven rules that keep two agent teams from colliding
1. **The contract is `packages/shared/src/types.ts`.** Routes, request and response shapes, SSE events. Frontend builds against it; backend implements it. It changes only in its own PR containing nothing else, and the PR tags both humans. If the contract doesn't have what you need, ask on the Board; don't invent a field.
2. **Stay on your side of the table above.** Need something on the other side? Board post tagging the owner, or open a PR into their scope and let *their* orchestrator merge it. Never edit their files on your branch.
3. **One orchestrator per side merges.** Subagents branch, commit, push, open a PR, and stop. Only the side's orchestrator (or its human) runs `gh pr merge`. Nobody merges the other side's PRs.
4. **One worktree per agent.** Subagents never share a checkout: `git worktree add ../wt/<branch> -b <branch> origin/main`. The main checkout belongs to the human.
5. **One task, one branch, one PR, one stream label.** A subagent's brief names the exact paths it may touch. Touching anything else is a failed task, not initiative.
6. **Lockfile:** only add dependencies to your own package's `package.json`. If `pnpm-lock.yaml` conflicts on rebase, take `main`'s copy and run `pnpm install`; never hand-merge it.
7. **Frontend never waits on backend.** `STORE=memory pnpm dev:api` runs the whole API on a laptop with no credentials. If an endpoint in the contract isn't implemented yet, mock it from the schema and keep going.

## The loop (every change, no exceptions)
```
git fetch origin
git worktree add ../wt/<name> -b <feat|fix|infra>/<stream-letter>-<short-name> origin/main   # humans may just branch
# work; run tests + lint locally
git push -u origin HEAD
gh pr create --fill --label stream:<X>
# Gitar reviews. Address every comment or reply with why not.
gh pr merge --auto --squash          # lands via merge queue when Gitar + CI are green
gh issue comment 2 --body "<Stream>: <what landed> in #<pr>. Next: <thing>. Blocked: <none|what>"
```
- One feature per PR, **under 300 lines of diff**. Bigger → split.
- Pull `main` before every branch. Rebase, don't merge, if behind.
- No tests for what you changed? Add one. CI runs typecheck, lint, tests: `pnpm check` runs the same thing locally.
- Only `gh pr merge --auto` lands code. Nobody pushes to `main`. Nobody force-pushes anywhere.

## The Board (Issue #2, pinned)
Post when you land something, when you're blocked for more than 10 minutes, or when you need another stream. Format: `<Stream>: <one line>. Next: <one line>. Blocked: <none|what>`. Tag humans with @. Humans read it every 30 minutes. Board posts are ingested into the brain.

## Hard rules
- No secrets in the repo. Env vars only; add new ones to `.env.example`. Kubernetes Secrets are created by hand in the cluster, never committed.
- No fake data in demo paths. Seed data only behind `SEED=true`, labeled.
- Minimal personal data: name, team code, what they said. Nothing else.
- Every PR description states which AI tools wrote it (template has the line).
- No new dependency without a one-line reason in the PR.
- No outreach automation of any kind (LinkedIn, email, DMs).
- Decisions in PROJECT.md are final for today. Don't relitigate in PRs; post on the Board if something is actually impossible.

## Code conventions
- TypeScript strict. Named exports. Small modules. Early returns. `any` needs a comment.
- Every HTTP handler and worker step has an OpenTelemetry span with a meaningful name. Ingest is traced end to end: upload → transcribe → index → librarian.
- Errors logged once, with context, at the boundary. No swallowed errors.
- Times stored and transmitted as UTC ISO strings. Frontend converts to `America/Denver`.
- `context_raw` documents are immutable. Never update or delete them. Corrections are new documents.
- `CHAOS_MODE` defaults to false and is visibly labeled in the UI when on.
- Kubernetes manifests: requests and limits set, readiness probe, image tag = commit SHA, never `latest`. Team budget is 2 CPU / 4 GiB requests total.

## Using the brain (once `packages/mcp` lands)
Add once per laptop: `claude mcp add hack-harness-context --scope user --transport http <api-url>/mcp`.
Before starting a task, call `context_recent` and `context_decisions`. When you make a non-obvious choice, call `context_add` with one sentence. When unsure what the humans meant, `context_search` before asking.

## Roles
- **Fable orchestrator (one per side):** architecture and the contract, task briefs, merges for its side, deploy verification via Radar MCP (backend), Board posts. Writes scaffolding and docs; hands feature code to subagents.
- **Opus subagents:** feature work, one brief each, in a worktree.
- **Cam:** backend side. Elastic, cluster, credentials, architecture and the chaos moment in the pitch.
- **Jake:** frontend side. Design, demo visuals, pitch deck, problem/product in the pitch.
