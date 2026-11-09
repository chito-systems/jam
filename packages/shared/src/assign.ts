// Who should take a work order. Deterministic on purpose: no LLM, every answer names the rule that picked it.
import { normalizePath, sideOf } from "./tasks";
import { SIDE_PATHS, type Side, SideSchema } from "./types";

export interface RosterEntry {
  name: string;
  side: Side;
}

export const DEFAULT_ROSTER = "cam:backend,jake:frontend,chito-systems:backend,quakeob:frontend";

/** "cam:backend,jake:frontend" -> entries, lowercase names. Malformed entries are skipped. */
export function parseRoster(value: string | undefined): RosterEntry[] {
  const source = value?.trim() ? value : DEFAULT_ROSTER;
  const out: RosterEntry[] = [];
  for (const part of source.split(",")) {
    const [rawName, rawSide] = part.split(":").map((s) => s.trim().toLowerCase());
    const side = SideSchema.safeParse(rawSide);
    if (!rawName || !side.success || out.some((e) => e.name === rawName)) continue;
    out.push({ name: rawName, side: side.data });
  }
  return out;
}

export interface AssignInput {
  text: string;
  speaker: string;
  paths: string[];
  roster: RosterEntry[];
}

export interface Assignment {
  side: Side;
  suggested_owner?: string;
  reason: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const display = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Index of `name` in `text` as a whole word (letters, digits, `-` and `_` count as word characters), or -1. */
function wordIndex(text: string, name: string): number {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(name)}(?![\\p{L}\\p{N}_-])`, "iu");
  return text.search(re);
}

/** The SIDE_PATHS prefix a path falls under, for the reason sentence. */
function ownedPrefix(path: string, side: Side): string {
  const p = normalizePath(path);
  const hit = SIDE_PATHS[side].map(normalizePath).find((pre) => p === pre || p.startsWith(`${pre}/`));
  return hit ?? p;
}

/** First match wins: a named person, then the files' side, then the speaker's side, then backend. */
export function assignWork(input: AssignInput): Assignment {
  const { text, roster } = input;

  // 1. Someone was named. The earliest mention wins.
  const named = roster
    .map((e) => ({ e, at: wordIndex(text, e.name) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (named) {
    return {
      side: named.e.side,
      suggested_owner: named.e.name,
      reason: `${display(named.e.name)} was named in the request.`,
    };
  }

  // 2. Every file belongs to one side.
  const paths = input.paths.map(normalizePath).filter(Boolean);
  const sides = new Set(paths.map(sideOf));
  const [only] = [...sides];
  if (paths.length > 0 && sides.size === 1 && only) {
    const owner = roster.find((e) => e.side === only)?.name;
    const where = [...new Set(paths.map((p) => ownedPrefix(p, only)))].join(" and ");
    return {
      side: only,
      ...(owner ? { suggested_owner: owner } : {}),
      reason: `All the files are in ${where}, which the ${only} side owns.`,
    };
  }

  // 3. The speaker's side.
  const speaker = input.speaker.trim().toLowerCase().replace(/^agent:/, "");
  const who = roster.find((e) => e.name === speaker);
  if (who) {
    return {
      side: who.side,
      reason: `${display(who.name)} said it and nobody was named, so it defaults to the ${who.side} side.`,
    };
  }

  return { side: "backend", reason: "No rule matched; a captain should assign this." };
}
