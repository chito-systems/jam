# PITCH.md — the shared pitch file

Cam, Jake and the orchestrators keep this open all day. Add under your own heading; don't rewrite someone else's lines. SPEC.md is the product; this is how we say it out loud. Presentations 5:30–6:30 MT.

## What a hackathon pitch is (60-second primer)
Judges see ~50 teams. They remember **one moment** per team, and they score against the published track criteria. So a pitch is four things, in this order:
1. **A problem they've felt** (10 s). One sentence. No intro, no team bios.
2. **One thing working, live, end to end** (60 s). Not a tour of features. One flow.
3. **How it's built and why** (10 s). Name the sponsor tools by what they *did*, not that you used them.
4. **The last line** (10 s). The sentence you want repeated in the judges' room.

Then Q&A, which is where rule 7 lives: can both humans explain any file and any decision. One person talks, the other drives. Rehearse three times. Record a backup video at 4:30.

## The one-liner
**JAM is where a team's context lives when half the team is agents.** Talk, and every agent on the team knows within ten seconds.

## The big idea (say this, not "an IDE")
Code is cheap now; agents write it. What's scarce is **context**: what the humans said, decided and tried. Git versions the code. Nothing versions the conversation that caused the code. So agents diverge, and the humans become the message bus.

JAM treats what was said like source: captured once, immutable, searchable by everyone and every agent, and every decision links back to the moment someone said it.

## Why this is a conference project (the theme answer — have it ready)
Theme: "build anything that makes conferences better." We will be asked.
- **A conference is the densest context a developer gets all year, and almost none of it survives the flight home.** Hallway conversations, the maintainer who explained the thing, the booth demo. Follow-up dies (it's the #6 attendee complaint; badge scans are "a racket").
- The hackathon is Day 0 of that. We built the tool on the hardest case: 6 hours, two humans, a dozen agents.
- **Tomorrow we carry the same capture page around KubeCon.** Talk to a maintainer, hold the button, and the agent on your laptop knows what they told you. Same brain, same MCP tool.
- Voice-first capture is also the accessibility story (Merge Forward): no typing, no account, works one-handed on a phone.

## Wow moments, ranked by impact ÷ cost
| # | Moment | Why it lands | Cost | Status |
| --- | --- | --- | --- | --- |
| 1 | **A judge's own words in the brain.** Capture runs during Q&A. A judge asks a question; ten seconds later we search and their sentence is on screen, tagged. | Un-fakeable. They're in the product. Proves the <10 s number live. | Zero beyond v0 | needs v0 |
| 2 | **Judge supplies the fact.** "Tell the phone something only you know." A fresh Claude Code session answers it through MCP. | Kills "is this seeded?" before anyone asks. | Zero beyond MCP | needs MCP |
| 3 | **Receipts.** The README's decision log is generated from the brain; every decision links to the raw voice chunk where we said it. | Turns the AI-disclosure rule from a risk into the feature. "Here is every human decision, timestamped, and the PR it caused." | Librarian + one script | planned 2–3 pm |
| 4 | **Find the right talk, without searching.** The brain knows what we fought with today; it picks tomorrow's KubeCon sessions for us. The query is our day. | It's the Elastic track's title, inverted. Lands the theme. | Schedule ingest + one query, 1 PR | **decide by 2:00** |
| 5 | **The SLO is on the screen.** Every capture shows "searchable in 4.2 s". Flip chaos: the number goes red, Dash0 and Radar say why. | Observability as part of the product, which is the Dash0 criterion verbatim. | Already in the contract | needs deploy |
| 6 | **Open to the room.** QR on the last slide: any team picks a code and it works for them now. | Answers "who is this for?" with "everyone in this room". | Already multi-tenant | free if deployed |

Pick **one** as the moment. Recommendation: #1 + #2 together (they're the same 20 seconds), with #3 as the closer.

## 90-second script (v1 — edit freely)
- **0:00 · Jake.** "Two people, a dozen coding agents, six hours. By noon nobody, human or agent, had the same picture of what we'd decided. Agents built the wrong thing confidently. We became the message bus."
- **0:12 · Jake.** "So at 11 we built the thing we needed, and used it to build itself." *(phone up, hold the button)* "Decision: the worker retries indexing three times, then drops to keyword-only."
- **0:22 · Cam.** *(screen: the capture lands, "searchable in 3.8 s")* "That's in Elasticsearch. Raw transcript, immutable, hybrid keyword-plus-semantic search."
- **0:30 · Cam.** *(fresh Claude Code terminal)* "What did we decide about indexing failures?" *(agent answers via MCP, cites Jake, cites the time)* "Every agent on both laptops reads the same brain. That one tool call is the whole harness."
- **0:45 · Cam.** *(merge queue)* "Every change today was a PR, reviewed by Gitar against our rules, landed through a queue. N PRs. Gitar caught ___."
- **0:55 · Cam.** *(flip chaos)* "Break the indexer." *(number goes red; Dash0 trace; Radar investigation)* "Dash0 shows the slow span. Radar's investigation names the cause."
- **1:10 · Jake.** *(README decision log)* "And here's every decision we made today, each linked to the moment we said it. That's our AI disclosure."
- **1:20 · Jake.** "Tomorrow we take the same button to KubeCon. Everything you just saw was built through itself. Repo's public."

**30-second cut:** 0:00 line → hold button, say a decision → agent answers it → last line.

## The delegation beat (new, 1:25)
Two laptops, two orchestrators, a dozen subagents, one repo. The demo: agent A claims `apps/api/`; agent B on the other laptop tries to touch `apps/api/src/app.ts` and gets told no, by name, with who holds it. Then show the tasks pane: who is editing what, live. Line: **"The delegator won't hand two agents the same file."** This is the concrete answer to "where's the harness?"

## Lines worth stealing
- "We became the message bus."
- "Git versions the code. Nothing versions the conversation that caused it."
- "The harness isn't a runtime. It's one MCP tool, one rules file and one merge queue."
- "Raw is the truth. The agent's summary is allowed to be wrong."
- "The feed is your own project." (focus pane)
- Avoid: "agent-pilled", "we let the agents do it", "AI-powered". The room is tired of it.

## Questions we will get (one-line answers; both humans learn these)
- **Hightower — "what's the simplest version of this?"** A record button, one Elasticsearch index, one MCP tool. Everything else is optional and we can say what we'd delete.
- **Garrison — "why Kubernetes at all?"** Honestly: it's two small Deployments. We're on it because Radar's cluster gave us GitOps and an AI SRE for free, and the ingest pipeline is the thing worth watching break.
- **Sandoval — "who is this for?"** Today: us and the 50 teams in this room. Next: any team where agents outnumber people.
- **Estes / Novack — "why Elasticsearch, not Postgres + pgvector?"** Hybrid BM25 + semantic in one query with RRF, embeddings computed on ingest by `semantic_text`, and immutability enforced by create-only writes. No embedding service to run.
- **Barreiro (Cline) — "where's the harness? did you build an agent?"** No. We orchestrate Claude Code. The harness is the shared context tool, the ownership rules, and the merge queue. Show AGENTS.md.
- **Furst Morgado (Dash0) — "what did observability find?"** ___ (fill with the real incident)
- **Erell (Radar) — "what did the investigation tell you?"** ___ (fill with the real one)
- **Schrottner (Flagsmith) — "is chaos a feature flag?"** It's an env flag today, off by default and labeled in the UI when on. A real flag service is the right next step.
- **Anyone — "did AI write all of this?"** Most of the code, under rules we wrote, every change through a reviewed PR. Ask us about any file. And the decision log shows which human decided what, and when.
- **Anyone — "is recording people okay?"** Hold-to-talk is the consent. Nothing records unless someone is holding the button. Team code scopes everything. Context expires unless exported.

## What we say doesn't work (be first to say it)
- No auth beyond a team code.
- (fill at 4:00 with what actually got cut)

## Focus-first interface — notes for Jake's side
- The pitch for the pane: while agents work, humans drift to their phones. So the feed lives in the tool, and the feed is your own project: transcripts landing, PRs merging, Gitar comments, the countdown.
- Backend gives you this for free: `GET /api/events` is an SSE stream of everything entering the brain (see `packages/shared/src/types.ts`, `FeedEvent`).
- Lunch/DoorDash, music, etc.: link out, don't automate. Nothing acts on a user's behalf.

## Open questions (answer inline)
- [ ] Cam/Jake: which wow moment is *the* moment?
- [ ] Do we build #4 (talk picks from today's context)? One PR, backend. Decide by 2:00.
- [ ] Who talks, who drives? (default: Jake talks problem + close, Cam drives and talks architecture)
- [ ] Final PR count, what Gitar caught, what Radar found — fill at 4:00.

## Notes log (append, newest last)
- **12:20 · Fable (backend).** Created this file. Contract is in `packages/shared/src/types.ts`. v0 capture is three PRs away.
- **1:10 · Fable (backend).** v0 is live against real Elasticsearch + Whisper. Measured: voice clip searchable in 4.1 s, text in 5.5 s (cold). Search returns `mode: "hybrid"`; a paraphrase with almost no shared words found the note. Embeddings are `jina-embeddings-v5-text-small` (1024-dim) via Elastic's inference service, computed on ingest by `semantic_text` — say that to the Elastic judges.
- **1:25 · Cam.** User-facing name is **JAM**. New pillar: **agent delegation** — agents claim paths before editing (`task_claim` over MCP); a claim that overlaps another agent's, or reaches into the other side's files, is refused. Everything in the brain is tagged backend or frontend.

### Cam

### Jake
