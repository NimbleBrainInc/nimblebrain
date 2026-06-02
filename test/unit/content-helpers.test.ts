import { describe, expect, it } from "bun:test";
import { boundToolResultForModel, estimateContentSize } from "../../src/engine/content-helpers.ts";
import type { ContentBlock } from "../../src/engine/types.ts";

describe("estimateContentSize", () => {
  it("returns 0 for empty array", () => {
    expect(estimateContentSize([])).toBe(0);
  });

  it("sums text block lengths", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world!" },
    ];
    expect(estimateContentSize(blocks)).toBe(11);
  });

  it("measures image block base64 data length", () => {
    const data = "aGVsbG8="; // 8 chars of base64
    const blocks = [{ type: "image", data, mimeType: "image/png" }] as unknown as ContentBlock[];
    expect(estimateContentSize(blocks)).toBe(8);
  });

  it("measures embedded resource text", () => {
    const blocks = [
      { type: "resource", resource: { text: "embedded content", uri: "file://test" } },
    ] as unknown as ContentBlock[];
    expect(estimateContentSize(blocks)).toBe(16);
  });

  it("measures embedded resource blob", () => {
    const blocks = [
      { type: "resource", resource: { blob: "YmxvYmRhdGE=", uri: "file://test" } },
    ] as unknown as ContentBlock[];
    expect(estimateContentSize(blocks)).toBe(12);
  });

  it("falls back to JSON.stringify for unknown block types", () => {
    const block = { type: "custom", payload: "data" } as unknown as ContentBlock;
    expect(estimateContentSize([block])).toBe(JSON.stringify(block).length);
  });

  it("handles mixed block types", () => {
    const blocks = [
      { type: "text", text: "abc" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ] as unknown as ContentBlock[];
    expect(estimateContentSize(blocks)).toBe(7); // 3 + 4
  });
});

describe("boundToolResultForModel", () => {
  it("returns text unchanged when at or under the limit", () => {
    expect(boundToolResultForModel("small", { limit: 100 })).toBe("small");
    const exact = "x".repeat(100);
    expect(boundToolResultForModel(exact, { limit: 100 })).toBe(exact);
  });

  it("bounds oversized text and appends an explicit, actionable marker", () => {
    const text = `${"a".repeat(40)}\n`.repeat(50); // ~2050 chars, line-delimited
    const out = boundToolResultForModel(text, { limit: 200 });
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("bounded for model context");
    expect(out).toContain("user's screen");
  });

  it("trims on a line boundary so records are not cut mid-line", () => {
    const text = `${"a".repeat(40)}\n`.repeat(50);
    const out = boundToolResultForModel(text, { limit: 200 });
    const head = out.split("\n\n[Result bounded")[0]!;
    // Every retained line is a complete 40-char record (no partial last line).
    for (const line of head.split("\n").filter(Boolean)) {
      expect(line).toBe("a".repeat(40));
    }
  });

  it("falls back to a hard slice when a single line exceeds the limit", () => {
    const text = "a".repeat(5000); // one line, no newline
    const out = boundToolResultForModel(text, { limit: 100 });
    expect(out.startsWith("a".repeat(100))).toBe(true);
    expect(out).toContain("bounded for model context");
  });

  it("returns an inline-UI pointer (not the payload) when hasUiResource", () => {
    const text = "z".repeat(5000);
    const out = boundToolResultForModel(text, { limit: 100, hasUiResource: true });
    expect(out).toContain("displayed in the inline UI");
    expect(out).not.toContain("z".repeat(100));
  });

  it("is deterministic — identical inputs yield identical output (stable cache prefix)", () => {
    const text = `${"line\n".repeat(1000)}`;
    expect(boundToolResultForModel(text, { limit: 200 })).toBe(
      boundToolResultForModel(text, { limit: 200 }),
    );
  });

  it("treats limit <= 0 as unbounded", () => {
    const text = "a".repeat(5000);
    expect(boundToolResultForModel(text, { limit: 0 })).toBe(text);
  });
});
