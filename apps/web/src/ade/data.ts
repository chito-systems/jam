// SAMPLE DATA for the local ADE. Nothing here comes from the API yet.
// Each list maps to a real source later: sessions from the agent runner,
// brain entries from /api/items, context from the MCP query log.

export type RunState = 'queued' | 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled'

export type BrainEntry = {
  id: string
  kind: 'decision' | 'todo' | 'question' | 'idea' | 'blocker' | 'fact'
  text: string
  who: string
  at: string
  source: 'voice' | 'text' | 'board' | 'pr'
  ref: string
}

export type Ev =
  | { t: 'user'; id: string; who: string; at?: string; text: string }
  | { t: 'agent'; id: string; text: string; cites?: string[]; thinking?: boolean }
  | { t: 'tool'; id: string; verb: string; target: string; result: string; ok: boolean; detail?: string }
  | { t: 'ask'; id: string; text: string; options: string[]; answer?: string }
  | { t: 'steer'; id: string; text: string }
  | { t: 'note'; id: string; text: string }

export type DiffLine = { k: ' ' | '+' | '-'; text: string }
export type FileChange = {
  path: string
  add: number
  del: number
  hunks: { header: string; start: [number, number]; lines: DiffLine[] }[]
}

export type ContextUse = { query: string; entries: string[]; files: string[] }
export type PlanStep = { text: string; done: boolean }

export type Session = {
  id: string
  title: string
  agent: string
  model: string
  owner: string
  branch: string
  stream: string
  pr?: number
  tokens: string
  state: RunState
  updated: string
  events: Ev[]
  changes: FileChange[]
  context: ContextUse[]
  plan: PlanStep[]
  reviewed: string[]
}

export const brain: Record<string, BrainEntry> = Object.fromEntries(
  (
    [
      { id: 'b1', kind: 'decision', text: 'Ingest is POST /api/ingest: JSON for text, multipart for files. It returns { capture_id, state }.', who: 'cam', at: '12:41', source: 'voice', ref: 'Kickoff recording, 04:12' },
      { id: 'b2', kind: 'decision', text: 'Web and API share one origin. Everything the API serves lives under /api.', who: 'cam', at: '12:44', source: 'voice', ref: 'Kickoff recording, 07:30' },
      { id: 'b3', kind: 'todo', text: 'Capture page still reads job_id. Realign it with the shared contract.', who: 'jake', at: '12:55', source: 'text', ref: 'Note from /capture' },
      { id: 'b4', kind: 'blocker', text: 'Whisper call times out on recordings over 2 minutes.', who: 'agent:opus-1', at: '13:20', source: 'board', ref: 'Board, issue #2' },
      { id: 'b5', kind: 'decision', text: 'context_raw is immutable: created once, never updated or deleted.', who: 'cam', at: '12:47', source: 'voice', ref: 'Kickoff recording, 11:02' },
      { id: 'b6', kind: 'fact', text: 'ms_to_searchable is the SLO number. Target is under 10 seconds.', who: 'cam', at: '12:49', source: 'pr', ref: 'PR #8, types.ts' },
      { id: 'b7', kind: 'idea', text: 'Chunk long audio at silence, 60 second ceiling, and transcribe chunks in parallel.', who: 'jake', at: '13:24', source: 'voice', ref: 'Voice note, 00:18' },
      { id: 'b8', kind: 'decision', text: 'OTel goes to Dash0. Every route gets a span through the withSpan helper.', who: 'cam', at: '12:52', source: 'pr', ref: 'PR #3' },
    ] as BrainEntry[]
  ).map((e) => [e.id, e]),
)

const ingestDiff: FileChange = {
  path: 'apps/web/src/lib/ingest.ts',
  add: 14,
  del: 8,
  hunks: [
    {
      header: 'export async function ingestText',
      start: [12, 12],
      lines: [
        { k: ' ', text: 'export async function ingestText(text: string, who: string) {' },
        { k: '-', text: "  const res = await fetch('/ingest', {" },
        { k: '+', text: '  const res = await fetch(ROUTES.ingest, {' },
        { k: ' ', text: "    method: 'POST'," },
        { k: ' ', text: "    headers: { 'content-type': 'application/json' }," },
        { k: '-', text: '    body: JSON.stringify({ text, who }),' },
        { k: '+', text: '    body: JSON.stringify(' },
        { k: '+', text: "      IngestTextRequestSchema.parse({ team_id: teamId(), who, type: 'text', text })," },
        { k: '+', text: '    ),' },
        { k: ' ', text: '  })' },
        { k: '-', text: '  const { job_id } = await res.json()' },
        { k: '-', text: '  return job_id as string' },
        { k: '+', text: '  if (!res.ok) throw new IngestError(res.status, await res.text())' },
        { k: '+', text: '  return IngestResponseSchema.parse(await res.json())' },
        { k: ' ', text: '}' },
      ],
    },
    {
      header: 'export async function captureStatus',
      start: [41, 44],
      lines: [
        { k: '-', text: 'export async function jobStatus(jobId: string) {' },
        { k: '-', text: '  const res = await fetch(`/jobs/${jobId}`)' },
        { k: '-', text: '  return res.json()' },
        { k: '+', text: 'export async function captureStatus(captureId: string) {' },
        { k: '+', text: "  const res = await fetch(ROUTES.capture.replace(':id', captureId))" },
        { k: '+', text: '  return CaptureStatusSchema.parse(await res.json())' },
        { k: ' ', text: '}' },
      ],
    },
  ],
}

const viteDiff: FileChange = {
  path: 'apps/web/vite.config.ts',
  add: 1,
  del: 2,
  hunks: [
    {
      header: 'server',
      start: [14, 14],
      lines: [
        { k: ' ', text: '    proxy: {' },
        { k: '-', text: "      '/ingest': API," },
        { k: '-', text: "      '/search': API," },
        { k: '+', text: "      '/api': API," },
        { k: ' ', text: '    },' },
      ],
    },
  ],
}

const chunkDiff: FileChange = {
  path: 'apps/worker/src/transcribe.ts',
  add: 9,
  del: 2,
  hunks: [
    {
      header: 'export async function transcribe',
      start: [20, 20],
      lines: [
        { k: ' ', text: 'export async function transcribe(file: Blob, startedAt: string) {' },
        { k: '-', text: '  const out = await whisper(file)' },
        { k: '-', text: '  return toRawDocs(out.segments, startedAt)' },
        { k: '+', text: '  const chunks = await splitAtSilence(file, { maxSeconds: 60 })' },
        { k: '+', text: '  const parts = await Promise.all(' },
        { k: '+', text: '    chunks.map((c) => withSpan("whisper.chunk", () => whisper(c.blob))),' },
        { k: '+', text: '  )' },
        { k: '+', text: '  return parts.flatMap((p, i) =>' },
        { k: '+', text: '    toRawDocs(p.segments, offset(startedAt, chunks[i].startSeconds)),' },
        { k: '+', text: '  )' },
        { k: ' ', text: '}' },
      ],
    },
  ],
}

const mcpDiff: FileChange = {
  path: 'packages/mcp/src/tools/context-search.ts',
  add: 11,
  del: 0,
  hunks: [
    {
      header: 'new file',
      start: [0, 1],
      lines: [
        { k: '+', text: "import { SearchParamsSchema, SearchResponseSchema } from '@hh/shared'" },
        { k: '+', text: '' },
        { k: '+', text: 'export const contextSearch = defineTool({' },
        { k: '+', text: "  name: 'context_search'," },
        { k: '+', text: "  description: 'Search what the team has said, decided and shipped.'," },
        { k: '+', text: "  input: SearchParamsSchema.omit({ team_id: true })," },
        { k: '+', text: '  async run(input, ctx) {' },
        { k: '+', text: '    const res = await ctx.api.search({ ...input, team_id: ctx.teamId })' },
        { k: '+', text: '    return SearchResponseSchema.parse(res)' },
        { k: '+', text: '  },' },
        { k: '+', text: '})' },
      ],
    },
  ],
}

export const seedSessions: Session[] = [
  {
    id: 's1',
    title: 'Align /capture with the ingest contract',
    agent: 'sonnet-1',
    model: 'Sonnet 5.5',
    owner: 'jake',
    branch: 'feat/B-capture-contract',
    stream: 'B · UI',
    tokens: '41k',
    state: 'needs_input',
    updated: '1m',
    reviewed: [],
    plan: [
      { text: 'Read the shared contract', done: true },
      { text: 'Point ingest calls at /api/ingest', done: true },
      { text: 'Replace job_id with capture_id', done: false },
      { text: 'Poll /api/captures/:id until searchable', done: false },
    ],
    context: [
      { query: 'ingest contract', entries: ['b1', 'b2', 'b3'], files: ['packages/shared/src/types.ts'] },
      { query: 'searchable SLO', entries: ['b6'], files: [] },
    ],
    changes: [ingestDiff, viteDiff],
    events: [
      { t: 'user', id: 'e1', who: 'jake', at: '13:02', text: 'The capture page is still on the old /ingest shape. Bring it in line with the shared contract.' },
      { t: 'tool', id: 'e2', verb: 'Searched brain', target: 'ingest contract', result: '3 entries', ok: true, detail: 'b1  decision  cam    Ingest is POST /api/ingest …\nb2  decision  cam    Web and API share one origin …\nb3  todo      jake   Capture page still reads job_id …' },
      { t: 'tool', id: 'e3', verb: 'Read', target: 'packages/shared/src/types.ts', result: '214 lines', ok: true },
      { t: 'agent', id: 'e4', text: 'The contract moved in two ways. Ingest now lives at `/api/ingest` and answers with `{ capture_id, state }`, and status moved to `/api/captures/:id`. The page still posts to `/ingest` and reads `job_id`.', cites: ['b1', 'b2', 'b3'] },
      { t: 'tool', id: 'e5', verb: 'Edited', target: 'apps/web/src/lib/ingest.ts', result: '+14 −8', ok: true },
      { t: 'tool', id: 'e6', verb: 'Edited', target: 'apps/web/vite.config.ts', result: '+1 −2', ok: true },
      { t: 'tool', id: 'e7', verb: 'Ran', target: 'pnpm --filter @hh/web test', result: '6 passed', ok: true, detail: ' ✓ src/lib/ingest.test.ts (4)\n ✓ src/lib/identity.test.ts (2)\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)' },
      { t: 'ask', id: 'e8', text: 'CapturePage.tsx reads job_id in 5 places. Rename them to capture_id, or keep the page as is and map the name in ingest.ts?', options: ['Rename everywhere', 'Map it in ingest.ts'] },
    ],
  },
  {
    id: 's2',
    title: 'Whisper times out past 2 minutes',
    agent: 'opus-1',
    model: 'Opus 5.5',
    owner: 'cam',
    branch: 'fix/A-whisper-chunking',
    stream: 'A · Brain',
    pr: 7,
    tokens: '182k',
    state: 'failed',
    updated: '6m',
    reviewed: [],
    plan: [
      { text: 'Reproduce with a 3 minute recording', done: true },
      { text: 'Split audio at silence', done: true },
      { text: 'Transcribe chunks in parallel', done: true },
      { text: 'Keep chunk times as offsets', done: false },
    ],
    context: [{ query: 'whisper timeout', entries: ['b4', 'b7', 'b5'], files: ['apps/worker/src/transcribe.ts'] }],
    changes: [chunkDiff],
    events: [
      { t: 'user', id: 'e1', who: 'cam', at: '12:26', text: 'Recordings over two minutes never reach indexed. Fix the worker.' },
      { t: 'tool', id: 'e2', verb: 'Searched brain', target: 'whisper timeout', result: '3 entries', ok: true },
      { t: 'agent', id: 'e3', text: 'The board has the blocker, and Jake left a voice note with an approach: split at silence with a 60 second ceiling and transcribe in parallel. I am taking that route.', cites: ['b4', 'b7'] },
      { t: 'tool', id: 'e4', verb: 'Edited', target: 'apps/worker/src/transcribe.ts', result: '+9 −2', ok: true },
      { t: 'tool', id: 'e5', verb: 'Ran', target: 'pnpm --filter @hh/worker test', result: '1 failed', ok: false, detail: ' ✗ transcribe > keeps chunk times as offsets from startedAt\n   expected "2026-11-09T19:05:00.000Z"\n   received "2026-11-09T19:04:00.000Z"\n\n Test Files  1 failed (1)\n      Tests  1 failed | 7 passed (8)' },
      { t: 'agent', id: 'e6', text: 'Stopped on a failing test. The second chunk starts a minute early: `splitAtSilence` reports `startSeconds` relative to the previous chunk, not the recording. Nothing was committed.' },
    ],
  },
  {
    id: 's3',
    title: 'context_search MCP tool',
    agent: 'opus-2',
    model: 'Opus 5.5',
    owner: 'cam',
    branch: 'feat/D-context-mcp',
    stream: 'D · MCP',
    pr: 6,
    tokens: '65k',
    state: 'done',
    updated: '14m',
    reviewed: [],
    plan: [
      { text: 'Define the tool from SearchParams', done: true },
      { text: 'Call /api/search with the team id', done: true },
      { text: 'Test against the in-memory store', done: true },
    ],
    context: [{ query: 'search contract', entries: ['b2', 'b6'], files: ['packages/shared/src/types.ts'] }],
    changes: [mcpDiff],
    events: [
      { t: 'user', id: 'e1', who: 'cam', at: '12:48', text: 'Add a context_search tool to the MCP server so agents can query the brain.' },
      { t: 'tool', id: 'e2', verb: 'Searched brain', target: 'search contract', result: '2 entries', ok: true },
      { t: 'tool', id: 'e3', verb: 'Created', target: 'packages/mcp/src/tools/context-search.ts', result: '+11', ok: true },
      { t: 'tool', id: 'e4', verb: 'Ran', target: 'pnpm --filter @hh/mcp test', result: '3 passed', ok: true },
      { t: 'agent', id: 'e5', text: 'Added `context_search`. It takes the search params without `team_id` and fills the team from the connection. Tested against the in-memory store only, so results are keyword mode. Not checked against Elastic.', cites: ['b2'] },
    ],
  },
  {
    id: 's4',
    title: 'OTel spans on the API routes',
    agent: 'fable',
    model: 'Fable 5.1',
    owner: 'cam',
    branch: 'infra/C-otel-api',
    stream: 'C · Platform',
    tokens: '97k',
    state: 'running',
    updated: 'now',
    reviewed: [],
    plan: [
      { text: 'Wrap /api/ingest', done: true },
      { text: 'Wrap /api/search and /api/recent', done: false },
      { text: 'Check traces in Dash0', done: false },
    ],
    context: [{ query: 'otel', entries: ['b8'], files: ['apps/api/src/otel.ts'] }],
    changes: [],
    events: [
      { t: 'user', id: 'e1', who: 'cam', at: '13:18', text: 'Put a span on every API route.' },
      { t: 'tool', id: 'e2', verb: 'Searched brain', target: 'otel', result: '1 entry', ok: true },
      { t: 'tool', id: 'e3', verb: 'Read', target: 'apps/api/src/otel.ts', result: '48 lines', ok: true },
      { t: 'agent', id: 'e4', text: 'Using the `withSpan` helper from PR #3. Starting with ingest, then the read routes.', cites: ['b8'] },
    ],
  },
  {
    id: 's5',
    title: 'Brain page: list with provenance',
    agent: 'sonnet-2',
    model: 'Sonnet 5.5',
    owner: 'jake',
    branch: 'feat/B-brain',
    stream: 'B · UI',
    tokens: '0',
    state: 'queued',
    updated: '2m',
    reviewed: [],
    plan: [],
    context: [],
    changes: [],
    events: [{ t: 'user', id: 'e1', who: 'jake', at: '13:20', text: 'Build /brain: every entry links back to the capture it came from.' }],
  },
  {
    id: 's6',
    title: 'Dockerfiles and Argo CD app',
    agent: 'fable',
    model: 'Fable 5.1',
    owner: 'cam',
    branch: 'infra/C-docker-deploy',
    stream: 'C · Platform',
    pr: 4,
    tokens: '58k',
    state: 'done',
    updated: '48m',
    reviewed: ['*'],
    plan: [
      { text: 'Dockerfiles for web, api, worker', done: true },
      { text: 'Argo CD application', done: true },
    ],
    context: [],
    changes: [],
    events: [
      { t: 'user', id: 'e1', who: 'cam', at: '11:40', text: 'Containerize the three apps and add the Argo CD application.' },
      { t: 'agent', id: 'e2', text: 'Merged as PR #4. Web and API report healthy in the team namespace.' },
    ],
  },
]

export const people = [
  { name: 'cam', doing: 'reviewing #6' },
  { name: 'jake', doing: 'here' },
]

export type QueuedPr = { number: number; title: string; stream: 'A' | 'B' | 'C' | 'D'; status: 'merged' | 'merging' | 'checks' | 'changes'; gitar: string }
export type BoardPost = { id: string; who: string; at: string; text: string }

export const board: BoardPost[] = [
  { id: 'p1', who: 'agent:opus-1', at: '2026-11-09T19:05:00Z', text: 'A: /ingest text + /search landed in #3. Next: worker transcription. Blocked: none' },
  { id: 'p2', who: 'agent:sonnet-1', at: '2026-11-09T19:14:00Z', text: 'B: /capture page in #5. Next: brain page. Blocked: none' },
  { id: 'p3', who: 'agent:fable', at: '2026-11-09T19:18:00Z', text: 'C: Argo CD synced, web+api healthy on team namespace. Next: OTel bootstrap. Blocked: none' },
  { id: 'p4', who: 'cam', at: '2026-11-09T19:21:00Z', text: '@jake capture page looks great on my phone. Ring is a nice touch.' },
]

export const queue: QueuedPr[] = [
  { number: 3, title: 'feat(api): /ingest text and /search', stream: 'A', status: 'merged', gitar: 'Approved' },
  { number: 4, title: 'infra(C): Dockerfiles and Argo CD app', stream: 'C', status: 'merged', gitar: 'Approved, 1 fix auto-applied' },
  { number: 5, title: 'feat(web): /capture page', stream: 'B', status: 'merging', gitar: 'Approved' },
  { number: 6, title: 'feat(mcp): context_search tool', stream: 'D', status: 'checks', gitar: 'Reviewing' },
  { number: 7, title: 'feat(worker): Whisper transcription', stream: 'A', status: 'changes', gitar: 'context_raw doc updated in place' },
]
