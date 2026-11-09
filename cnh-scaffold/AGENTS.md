# AGENTS.md — Hack Harness

Rules for every coding agent and human in this repo. Read order: this file → PROJECT.md → NOW.md → Issue #1 (the Board). Keep this file short.

## Context
- Cloud Native Hackathon, Salt Lake City, 2026-11-09. Submission deadline **5:30 PM MT**. Freeze at 4:30.
- We are building Hack Harness, an Agent Development Environment for hackathon teams: shared context brain (Elasticsearch), safe merging for humans + agents (Gitar + merge queue), focus-first interface. PROJECT.md has the architecture; SPEC.md has the pitch.
- We use this product to build itself. From the moment `/capture` works, team conversations go into the brain and agents read it via the `context` MCP server.
- Judges read the repo. Write PRs you'd be proud to explain out loud.

## Streams and ownership (don't edit outside your stream)
| Stream | Label | Owner | Scope |
| --- | --- | --- | --- |
| A · Brain | `stream:A-brain` | Cam | `apps/api/`, `apps/worker/`, `packages/shared/`, Elastic mappings, ingest, transcription, librarian |
| B · UI | `stream:B-ui` | Jake | `apps/web/` — capture page, brain page, design system |
| C · Platform | `stream:C-platform` | Cam (Fable session) | `Dockerfile*`, `deploy/`, `argocd/`, `.github/`, OTel bootstrap, env, CI |
| D · MCP | `stream:D-mcp` | Cam (Opus session) | `packages/mcp/` |

The contract between streams is `packages/shared/src/types.ts`. Change it only in its own small PR, tag both owners on the Board.

Need something in another stream? Post on the Board and tag the owner, or open a PR into their scope and let them merge it. Never edit their files on your branch.

## The loop (every change, no exceptions)
```
git checkout main && git pull
git checkout -b <feat|fix|infra>/<stream-letter>-<short-name>
# work; run tests + lint locally
git push -u origin HEAD
gh pr create --fill --label stream:<X>
# Gitar reviews. Address every comment or reply with why not.
gh pr merge --auto --squash          # lands via merge queue when Gitar + CI are green
gh issue comment 1 --body "<Stream>: <what landed> in #<pr>. Next: <thing>. Blocked: <none|what>"
```
- One feature per PR, **under 300 lines of diff**. Bigger → split.
- Pull `main` before every branch. Rebase, don't merge, if behind.
- No tests for what you changed? Add one. CI runs typecheck, lint, tests.
- Only `gh pr merge --auto` lands code. Nobody pushes to `main`. Nobody force-pushes anywhere.

## The Board (Issue #1, pinned)
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
- **Fable (one session, Cam's laptop):** platform stream, merge coordination, deploy verification via Radar MCP, final README. No feature work.
- **Opus:** stream A features and stream D.
- **Sonnet:** stream B components, tests, small fixes.
- **Cam:** stream A, merges A/C/D, Elastic, cluster.
- **Jake:** stream B, merges B, design, demo visuals, pitch deck.
