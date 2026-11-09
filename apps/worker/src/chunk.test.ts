import { describe, expect, it } from "vitest";
import { chunkSegments, chunkText } from "./chunk";

describe("chunkText", () => {
  it("returns nothing for empty or whitespace text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n \n ")).toEqual([]);
  });

  it("packs short paragraphs together", () => {
    expect(chunkText("one\n\ntwo\n\n\nthree")).toEqual(["one\n\ntwo\n\nthree"]);
  });

  it("starts a new chunk when the next paragraph would overflow", () => {
    const a = "a".repeat(8);
    const b = "b".repeat(8);
    expect(chunkText(`${a}\n\n${b}`, 12)).toEqual([a, b]);
  });

  it("splits a long paragraph on sentence ends and never exceeds the limit", () => {
    const para = "First sentence here. Second one is here! Third? Fourth sentence.";
    const chunks = chunkText(para, 25);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 25 && c.length > 0)).toBe(true);
    expect(chunks.join(" ")).toBe(para);
  });

  it("hard-splits a sentence with no boundary", () => {
    const chunks = chunkText("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("chunkSegments", () => {
  it("merges consecutive segments up to the window", () => {
    const out = chunkSegments([
      { start_s: 0, end_s: 10, text: " hello " },
      { start_s: 10, end_s: 25, text: "world" },
      { start_s: 25, end_s: 40, text: "next window" },
    ]);
    expect(out).toEqual([
      { start_s: 0, end_s: 25, text: "hello world" },
      { start_s: 25, end_s: 40, text: "next window" },
    ]);
  });

  it("allows exactly the window length and drops empty segments", () => {
    const out = chunkSegments([
      { start_s: 0, end_s: 5, text: "a" },
      { start_s: 5, end_s: 6, text: "   " },
      { start_s: 6, end_s: 30, text: "b" },
    ]);
    expect(out).toEqual([{ start_s: 0, end_s: 30, text: "a b" }]);
  });

  it("returns nothing for silence", () => {
    expect(chunkSegments([])).toEqual([]);
    expect(chunkSegments([{ start_s: 0, end_s: 3, text: "" }])).toEqual([]);
  });
});
