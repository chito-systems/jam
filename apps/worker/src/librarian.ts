// The librarian: an async LLM pass that turns raw chunks into structured items (decisions, todos, ...).
// Allowed to be wrong; never touches raw docs. Every item links back to the chunks it came from.
import { type ItemDoc, ItemDocSchema, ItemKindSchema, type RawDoc, withSpan } from "@hh/shared";

/** New items the model scores below this are dropped: a gap is better than a guess. */
export const MIN_CONFIDENCE = 0.5;

type FetchImpl = typeof fetch;

export interface LibrarianInput {
  team_id: string;
  docs: RawDoc[];
  /** The team's most recent items, newest first, so the model can supersede or close them. */
  recent: ItemDoc[];
}

export interface Librarian {
  readonly name: string;
  extract(input: LibrarianInput): Promise<ItemDoc[]>;
}

export const DEFAULT_LIBRARIAN_MODEL = "gpt-5.4-mini";
export const MAX_ITEMS = 6;
const TIMEOUT_MS = 60_000;

const KINDS = ItemKindSchema.options;

export const SYSTEM_PROMPT = `You are the librarian for a hackathon team's shared memory. You read new transcript chunks (people talking, chat posts) and write the entries the team would want in its decision log.

Kinds: decision (someone chose something), todo (someone will or should do something), question (asked and not yet answered), blocker (something stopping work), idea (a proposal nobody committed to), fact (a useful concrete fact: a url, a version, a constraint), person (who owns or knows what).

Rules:
- One clean sentence per item, written so it stands alone without the transcript. Name the subject; no "it" or "this".
- Only extract what was actually said. Never invent details, owners or deadlines.
- A decision needs someone deciding ("we're going with", "let's do", "decided"), not musing ("maybe", "what if"). Musing is an idea.
- Write a question as the question itself ("Has anyone installed Gitar yet?"), not as reported speech.
- A request to a named person ("Jake, can you own X by 3") is a todo; write it as an assignment with the owner and deadline ("Jake owns the capture page design, due by 3.").
- who: the speaker of the chunk the item came from, exactly as given.
- raw_ids: ids of the chunks the item came from, only ids from the provided chunks.
- If a new statement reverses an existing item, return that existing item with existing_id set to its id and status "superseded", plus the new item. If a new statement completes an existing todo or answers an existing question, return the existing item with status "done". Otherwise existing_id is null and status is "open".
- Do not repeat an existing item that is unchanged.
- Never return a new item that says the same thing as an existing item, even in different words. Duplicates are worse than gaps.
- A status update that merely mentions a past decision ("as decided earlier", "landed X like we said") is not a new decision.
- An existing item with verdict "rejected" was judged wrong by a human: never extract it again.
- confidence: how directly the quoted chunks support the item. 0.9 or more: someone explicitly said it. About 0.6: clearly implied. Below 0.5: a guess, and you should prefer returning nothing over a guess. For an existing item you return, score the new statement that changes it.
- Small talk, jokes, complaints about the venue and filler produce nothing. An empty list is a good answer.
- At most ${MAX_ITEMS} items.
- tags: 1 to 3 short lowercase topic words (e.g. "search", "ui", "deploy").`;

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "librarian_items",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["existing_id", "kind", "text", "who", "raw_ids", "tags", "status", "confidence"],
            properties: {
              existing_id: { type: ["string", "null"] },
              kind: { type: "string", enum: KINDS },
              text: { type: "string" },
              who: { type: "string" },
              raw_ids: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
              status: { type: "string", enum: ["open", "done", "superseded"] },
              confidence: { type: "number" },
            },
          },
        },
      },
    },
  },
} as const;

/** What the model returns per item (before mapping). */
export interface ModelItem {
  existing_id: string | null;
  kind: string;
  text: string;
  who: string;
  raw_ids: string[];
  tags: string[];
  status: "open" | "done" | "superseded";
  /** 0..1, the model's own score of how directly the chunks support the item. */
  confidence: number;
}

export function buildUserMessage(input: LibrarianInput): string {
  const chunks = input.docs.map((d) => ({ id: d.id, who: d.who, at: d.at, text: d.text }));
  const existing = input.recent.map((i) => ({
    id: i.id,
    kind: i.kind,
    status: i.status,
    text: i.text,
    ...(i.verdict ? { verdict: i.verdict } : {}),
  }));
  return `Existing items (newest first):\n${JSON.stringify(existing)}\n\nNew chunks:\n${JSON.stringify(chunks)}`;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Parses the model's JSON content. Throws a clear error on anything malformed. */
export function parseModelOutput(content: string): ModelItem[] {
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    throw new Error(`librarian: model returned invalid JSON: ${content.slice(0, 200)}`);
  }
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("librarian: model output has no items array");
  return items.map((raw, i) => {
    const it = raw as Partial<ModelItem> | null;
    const ok =
      it &&
      (it.existing_id === null || it.existing_id === undefined || typeof it.existing_id === "string") &&
      ItemKindSchema.safeParse(it.kind).success &&
      typeof it.text === "string" &&
      typeof it.who === "string" &&
      isStringArray(it.raw_ids) &&
      isStringArray(it.tags) &&
      (it.status === "open" || it.status === "done" || it.status === "superseded") &&
      typeof it.confidence === "number" &&
      Number.isFinite(it.confidence);
    if (!ok) throw new Error(`librarian: malformed item ${i}: ${JSON.stringify(raw).slice(0, 200)}`);
    const confidence = Math.min(1, Math.max(0, it.confidence as number));
    return { ...it, existing_id: it.existing_id ?? null, confidence } as ModelItem;
  });
}

const sameText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Turns model output into valid ItemDocs. Drops unknown raw_ids, items left without provenance,
 * low-confidence guesses, and new items that repeat an existing one word for word.
 * An existing item keeps everything but its status: a human verdict is never overwritten.
 */
export function mapItems(
  modelItems: ModelItem[],
  input: LibrarianInput,
  newId: () => string = () => crypto.randomUUID(),
): ItemDoc[] {
  const byId = new Map(input.docs.map((d) => [d.id, d]));
  const recent = new Map(input.recent.map((i) => [i.id, i]));
  const known = new Set(input.recent.map((i) => sameText(i.text)));
  const out: ItemDoc[] = [];
  for (const m of modelItems) {
    const existing = m.existing_id ? recent.get(m.existing_id) : undefined;
    if (existing) {
      // Update in place (same id); provenance, confidence and any verdict stay as they were.
      // An existing id returned as "open" is an unchanged repeat: nothing to do.
      if (m.status !== "open") out.push(ItemDocSchema.parse({ ...existing, status: m.status }));
      continue;
    }
    if (m.confidence < MIN_CONFIDENCE || known.has(sameText(m.text))) continue;
    const raw_ids = [...new Set(m.raw_ids)].filter((id) => byId.has(id));
    const first = byId.get(raw_ids[0] ?? "");
    const text = m.text.trim();
    if (!first || !text) continue;
    const who = m.who.trim();
    const parsed = ItemDocSchema.safeParse({
      team_id: input.team_id,
      id: newId(),
      kind: m.kind,
      text,
      who: who && who.length <= 64 ? who : first.who,
      at: first.at,
      tags: [...new Set(m.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 3),
      raw_ids,
      status: m.status === "superseded" ? "open" : m.status,
      confidence: Math.round(m.confidence * 100) / 100,
    });
    if (!parsed.success) continue;
    out.push(parsed.data);
    known.add(sameText(text));
  }
  return out.slice(0, MAX_ITEMS * 2); // new items plus the existing ones they supersede
}

export interface OpenAILibrarianOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

export class OpenAILibrarian implements Librarian {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OpenAILibrarianOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_LIBRARIAN_MODEL;
    this.baseUrl = (opts.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = `openai:${this.model}`;
  }

  extract(input: LibrarianInput): Promise<ItemDoc[]> {
    const attrs = { team_id: input.team_id, chunks: input.docs.length, model: this.model };
    return withSpan("librarian.extract", attrs, async (span) => {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserMessage(input) },
          ],
          response_format: RESPONSE_FORMAT,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`OpenAI librarian failed: ${res.status} ${res.statusText} ${body}`.trim());
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }> };
      const message = body.choices?.[0]?.message;
      if (message?.refusal) throw new Error(`librarian: model refused: ${message.refusal.slice(0, 200)}`);
      if (typeof message?.content !== "string") throw new Error("librarian: response has no message content");
      const items = mapItems(parseModelOutput(message.content), input);
      span.setAttribute("items", items.length);
      return items;
    });
  }
}

/** An OpenAILibrarian when OPENAI_API_KEY is set and LIBRARIAN isn't "off"; otherwise undefined. */
export function createLibrarianFromEnv(env: NodeJS.ProcessEnv): Librarian | undefined {
  if ((env.LIBRARIAN || "on").trim().toLowerCase() === "off") return undefined;
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAILibrarian({
    apiKey,
    model: env.LIBRARIAN_MODEL?.trim() || undefined,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
  });
}
