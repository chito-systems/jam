# Gitar review instructions — Hack Harness

Review every PR against these. Quote the line, say what's wrong, propose the fix. This is a one-day hackathon with humans and coding agents as authors; prioritize bugs and risks over style. Be short and concrete.

## Fail the review if
- Any secret, token, API key, `.env` file, or Kubernetes Secret manifest with data is in the diff.
- A commit lands on `main` outside a merged PR.
- A `context_raw` document is updated or deleted anywhere in the code. Those documents are immutable; corrections are new documents.
- A new module has no test.
- A Kubernetes manifest lacks resource requests/limits or a readiness probe, or uses the `latest` tag.
- Any code performs outreach (LinkedIn, email, DMs) on a user's behalf.

## Warn if
- Diff over 300 lines. Ask the author to split.
- A changed module has no test change.
- A new dependency has no stated reason in the PR description.
- The PR touches files outside its `stream:` label's scope (see AGENTS.md ownership table). Ask whether the owner agreed on the Board.
- `packages/shared/src/types.ts` changes together with feature code. Types change in their own PR.
- Any new HTTP handler or worker step lacks an OpenTelemetry span.
- Any swallowed error (`catch {}` or a catch that only logs and continues without context).
- A date is constructed or formatted without an explicit UTC/ISO form in api/worker, or without `America/Denver` in web.
- An Elasticsearch query hardcodes an index name (should come from config), or a hybrid query lacks RRF/explicit weighting, or a kNN query's vector dimension doesn't match the mapping.
- Frontend change doesn't handle loading and error states or doesn't work at 375 px width.
- `CHAOS_MODE` or `SEED` is read without defaulting to off, or chaos is active without a visible UI label.

## CI
If CI fails, diagnose the failing step and propose the fix. Auto-apply is on for lint, formatting and type errors only.

## Style
TypeScript strict. Named exports. Small functions. Early returns. Comments say why, not what. `any` needs a comment.
