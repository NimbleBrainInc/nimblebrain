import { describe, expect, it } from "bun:test";
import { estimateContentSize } from "../../src/engine/content-helpers.ts";
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
