import { describe, expect, it } from "vitest";
import { assignWork, DEFAULT_ROSTER, parseRoster } from "./assign";

const roster = parseRoster(undefined);
const base = { text: "add a loading state", speaker: "nobody", paths: [] as string[], roster };

describe("parseRoster", () => {
  it("defaults to the team roster", () => {
    expect(parseRoster("")).toEqual(parseRoster(DEFAULT_ROSTER));
    expect(roster).toEqual([
      { name: "cam", side: "backend" },
      { name: "jake", side: "frontend" },
      { name: "chito-systems", side: "backend" },
      { name: "quakeob", side: "frontend" },
    ]);
  });

  it("lowercases, trims, skips malformed and duplicate entries", () => {
    expect(parseRoster(" Ana:Frontend , bob, carl:middle, :backend, ana:backend, dee:backend ")).toEqual([
      { name: "ana", side: "frontend" },
      { name: "dee", side: "backend" },
    ]);
  });
});

describe("assignWork", () => {
  it("1: a named person wins, as a whole word, case-insensitive", () => {
    expect(assignWork({ ...base, text: "JAKE, can you add buttons", speaker: "cam", paths: ["apps/api"] })).toEqual({
      side: "frontend",
      suggested_owner: "jake",
      reason: "Jake was named in the request.",
    });
    // "camera" is not "cam"; "chito-systems" is matched whole.
    expect(assignWork({ ...base, text: "fix the camera, chito-systems" }).suggested_owner).toBe("chito-systems");
  });

  it("1: the earliest mention wins when several people are named", () => {
    expect(assignWork({ ...base, text: "cam and jake should pair on it" }).suggested_owner).toBe("cam");
  });

  it("2: all paths on one side pick that side and its first roster name", () => {
    expect(assignWork({ ...base, speaker: "cam", paths: ["apps/web/src/App.tsx", "./apps/web/src/x/**"] })).toEqual({
      side: "frontend",
      suggested_owner: "jake",
      reason: "All the files are in apps/web, which the frontend side owns.",
    });
    expect(assignWork({ ...base, paths: ["apps/api/src", "packages/shared"] }).reason).toBe(
      "All the files are in apps/api and packages, which the backend side owns.",
    );
  });

  it("2 does not apply to mixed or unowned paths", () => {
    const mixed = assignWork({ ...base, speaker: "jake", paths: ["apps/web", "apps/api"] });
    expect(mixed).toEqual({
      side: "frontend",
      reason: "Jake said it and nobody was named, so it defaults to the frontend side.",
    });
    expect(assignWork({ ...base, speaker: "cam", paths: ["README.md"] }).reason).toMatch(/^Cam said it/);
  });

  it("3: the speaker's side, with an agent: prefix stripped and no owner", () => {
    expect(assignWork({ ...base, speaker: "agent:Cam" })).toEqual({
      side: "backend",
      reason: "Cam said it and nobody was named, so it defaults to the backend side.",
    });
  });

  it("4: nothing matched", () => {
    expect(assignWork({ ...base, speaker: "gitar" })).toEqual({
      side: "backend",
      reason: "No rule matched; a captain should assign this.",
    });
  });
});
