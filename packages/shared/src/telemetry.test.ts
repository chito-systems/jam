import { describe, expect, it } from "vitest";
import { withSpan } from "./telemetry";

describe("withSpan", () => {
  it("returns the wrapped value", async () => {
    expect(await withSpan("test.ok", {}, async () => 42)).toBe(42);
  });

  it("rethrows the wrapped error", async () => {
    await expect(
      withSpan("test.fail", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
