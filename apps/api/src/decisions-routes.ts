// The decision log with receipts: GET /api/decisions.md?team_id=<code>[&kinds=decision,todo,question]
// Markdown meant to be pasted into a README: every decision, who made it, when, and the exact words.
// Transcript text is untrusted input, so everything that came from a human or the LLM is escaped.
import {
  type ApiError,
  type ContextStore,
  type ItemDoc,
  type ItemKind,
  ItemKindSchema,
  MAX_RAW_BY_IDS,
  type RawDoc,
  ROUTES,
} from "@hh/shared";
import type { Hono } from "hono";

const ZONE = "America/Denver";
const QUOTE_MAX = 300;
const LIMIT = 200;

const SECTION_TITLES: Record<ItemKind, string> = {
  decision: "Decisions",
  todo: "Open todos",
  question: "Open questions",
  blocker: "Open blockers",
  idea: "Open ideas",
  fact: "Facts",
  person: "People",
};

const apiError = (error: string, detail?: unknown): ApiError =>
  detail === undefined ? { error } : { error, detail };

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, ...opts });
const timeFmt = fmt({ hour: "numeric", minute: "2-digit" });
const secondsFmt = fmt({ hour: "numeric", minute: "2-digit", second: "2-digit" });
const dayFmt = fmt({ month: "short", day: "numeric" });
const stampFmt = fmt({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// ICU puts a narrow no-break space before AM/PM; plain spaces read better in raw markdown.
const plain = (s: string) => s.replace(/\s/g, " ");

export const denverTime = (iso: string) => plain(timeFmt.format(new Date(iso)));
export const denverSeconds = (iso: string) => plain(secondsFmt.format(new Date(iso)));

/** "YYYY-MM-DD HH:mm" in Denver. */
export function denverStamp(date: Date): string {
  const p = Object.fromEntries(stampFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** One line of inline markdown from untrusted text: no newlines, no syntax that could break the page. */
export function escapeInline(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]|~<>#]/g, "\\$&");
}

/** Code spans can't escape a backtick, so drop them. */
const code = (s: string) => `\`${s.replace(/`/g, "")}\``;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= QUOTE_MAX) return flat;
  const cut = flat.slice(0, QUOTE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > QUOTE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `seen`: chunks already quoted in this response; repeats get a back-reference instead of the full quote. */
function quotes(item: ItemDoc, raws: Map<string, RawDoc>, seen: Set<string>, prefix = ""): string[] {
  if (item.raw_ids.length === 0) return [`${prefix}> (source chunk not found)`];
  return item.raw_ids.map((id) => {
    const r = raws.get(id);
    if (!r) return `${prefix}> (source chunk not found) (${code(id)})`;
    if (seen.has(id)) return `${prefix}> same source as above (${code(id)})`;
    seen.add(id);
    const said = escapeInline(clip(r.text));
    return `${prefix}> "${said}" — ${escapeInline(r.who)}, ${denverSeconds(r.at)}, ${r.type} (${code(r.id)})`;
  });
}

export function parseKinds(input: string | undefined): ItemKind[] | undefined {
  const kinds: ItemKind[] = ["decision"];
  for (const part of (input ?? "").split(",")) {
    const k = part.trim();
    if (!k) continue;
    const parsed = ItemKindSchema.safeParse(k);
    if (!parsed.success) return undefined;
    if (!kinds.includes(parsed.data)) kinds.push(parsed.data);
  }
  return kinds;
}

const oldestFirst = (a: ItemDoc, b: ItemDoc) => a.at.localeCompare(b.at);

export function renderDecisionLog(input: {
  team_id: string;
  now: Date;
  sections: Array<{ kind: ItemKind; items: ItemDoc[] }>;
  raws: Map<string, RawDoc>;
}): string {
  const { team_id, now, sections, raws } = input;
  const seen = new Set<string>();
  const all = sections.flatMap((s) => s.items);
  const multiDay = new Set(all.map((i) => dayFmt.format(new Date(i.at)))).size > 1;
  const when = (iso: string) =>
    multiDay ? `${plain(dayFmt.format(new Date(iso)))}, ${denverTime(iso)}` : denverTime(iso);

  const out = [
    `# Decision log — ${escapeInline(team_id)}`,
    "",
    `_Generated ${denverStamp(now)} MT from the team's captured conversation. Every entry links to the words it came from. Raw transcripts are immutable; this summary layer is written by an LLM and can be wrong, which is why the quotes are here._`,
    "",
  ];

  const decisions = [...(sections.find((s) => s.kind === "decision")?.items ?? [])].sort(oldestFirst);
  if (decisions.length === 0) {
    out.push("No decisions captured yet. Talk it through near a mic and they will show up here, with receipts.", "");
  } else {
    const superseded = decisions.filter((d) => d.status === "superseded").length;
    const noun = decisions.length === 1 ? "decision" : "decisions";
    out.push(`**${decisions.length} ${noun}** · ${superseded} superseded`, "");
    if (decisions.length >= LIMIT) {
      out.push(`_Showing the newest ${LIMIT} decisions; older ones exist and are not listed._`, "");
    }
    for (const d of decisions) {
      const head = `${when(d.at)} — ${escapeInline(d.text)}`;
      const by = `**${escapeInline(d.who)}**`;
      const tags = d.tags.length ? ` · tags: ${d.tags.map(code).join(" ")}` : "";
      if (d.status === "superseded") out.push(`## ~~${head}~~`, `Superseded · decided by ${by}${tags}`);
      else out.push(`## ${head}`, `Decided by ${by}${tags}`);
      for (const q of quotes(d, raws, seen)) out.push("", q);
      out.push("");
    }
  }

  for (const { kind, items } of sections) {
    if (kind === "decision") continue;
    const more = items.length >= LIMIT ? `, newest ${LIMIT} shown` : "";
    out.push("---", "", `## ${SECTION_TITLES[kind]} (${items.length}${more})`, "");
    if (items.length === 0) out.push("None right now.", "");
    for (const i of [...items].sort(oldestFirst)) {
      out.push(`- ${when(i.at)} — ${escapeInline(i.text)} — **${escapeInline(i.who)}**`);
      for (const q of quotes(i, raws, seen, "  ")) out.push(q);
      out.push("");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export function registerDecisionRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: shares the app's env without importing it
  app: Hono<any>,
  { store, now = () => new Date() }: { store: ContextStore; now?: () => Date },
) {
  app.get(ROUTES.decisionsMd, async (c) => {
    const team_id = c.req.query("team_id")?.trim();
    if (!team_id || team_id.length > 64) return c.json(apiError("team_id is required (1-64 chars)"), 400);
    const kinds = parseKinds(c.req.query("kinds"));
    if (!kinds) {
      return c.json(apiError("kinds must be comma-separated item kinds", ItemKindSchema.options), 400);
    }
    const sections = await Promise.all(
      kinds.map(async (kind) => ({
        kind,
        // Decisions keep their superseded history; extra sections show only what's still open.
        items: await store.items({ team_id, kind, limit: LIMIT, ...(kind === "decision" ? {} : { status: "open" }) }),
      })),
    );
    const ids = [...new Set(sections.flatMap((s) => s.items.flatMap((i) => i.raw_ids)))];
    // Batched so every referenced id gets looked up: "not found" must only ever mean not found.
    const raws = new Map<string, RawDoc>();
    for (let n = 0; n < ids.length; n += MAX_RAW_BY_IDS) {
      for (const r of await store.rawByIds(team_id, ids.slice(n, n + MAX_RAW_BY_IDS))) raws.set(r.id, r);
    }
    const md = renderDecisionLog({ team_id, now: now(), sections, raws });
    return c.body(md, 200, { "content-type": "text/markdown; charset=utf-8" });
  });
}
