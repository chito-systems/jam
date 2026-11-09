import { describe, expect, it } from "vitest";
import { CAPTURE_PAGE_HTML } from "./capture-page.js";

function inlineScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no inline <script> in capture page");
  return match[1];
}

describe("bootstrap capture page", () => {
  it("is a real page that talks to every route it needs", () => {
    expect(CAPTURE_PAGE_HTML.length).toBeGreaterThan(5000);
    for (const route of ["/api/ingest", "/api/captures/", "/api/search", "/api/recent"]) {
      expect(CAPTURE_PAGE_HTML).toContain(route);
    }
    expect(CAPTURE_PAGE_HTML).toContain("bootstrap capture page — replaced by /capture");
  });

  it("has an inline script that parses", () => {
    // Construct only, never call: catches syntax errors without a DOM.
    expect(() => new Function(inlineScript(CAPTURE_PAGE_HTML))).not.toThrow();
  });

  it("never writes server text through innerHTML", () => {
    expect(inlineScript(CAPTURE_PAGE_HTML)).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});
