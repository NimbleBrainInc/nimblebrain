import { describe, expect, test } from "bun:test";
import { boundToolResultForModel, extractTextForModel } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { MAX_TOOL_RESULT_CHARS } from "../../src/limits.ts";
import { withStructuredContentText } from "../../src/tools/structured-content-text.ts";

const LEDGER = {
  records: [
    { id: "101", vendor: "Acme Paper", amount: "250.00" },
    { id: "102", vendor: "Acme Ink", amount: "75.50" },
  ],
  totalCount: 2,
  hasMore: false,
};

function summaryOnly(structured: Record<string, unknown> = LEDGER): ToolResult {
  return {
    content: [{ type: "text", text: "Query executed successfully. Found 2 record(s)." }],
    structuredContent: structured,
    isError: false,
  };
}

describe("withStructuredContentText", () => {
  test("a summary with the rows only in structuredContent gives the model the rows", () => {
    const text = extractTextForModel(withStructuredContentText(summaryOnly()).content);
    expect(text).toBe(`Query executed successfully. Found 2 record(s).\n${JSON.stringify(LEDGER)}`);
  });

  test("a text block that already duplicates structuredContent is not doubled", () => {
    const result: ToolResult = {
      content: [{ type: "text", text: JSON.stringify(LEDGER, null, 2) }],
      structuredContent: LEDGER,
      isError: false,
    };
    expect(withStructuredContentText(result)).toBe(result);
  });

  test("a duplicate the model cannot see does not count", () => {
    const result: ToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify(LEDGER),
          annotations: { audience: ["user"] },
        } as ToolResult["content"][number],
      ],
      structuredContent: LEDGER,
      isError: false,
    };
    expect(extractTextForModel(withStructuredContentText(result).content)).toBe(
      JSON.stringify(LEDGER),
    );
  });

  test("an error result is unchanged", () => {
    const result: ToolResult = {
      content: [{ type: "text", text: "Ledger unavailable." }],
      structuredContent: { reason: "upstream_down" },
      isError: true,
    };
    expect(withStructuredContentText(result)).toBe(result);
  });

  test("a result without structuredContent is unchanged", () => {
    const result: ToolResult = { content: [{ type: "text", text: "ok" }], isError: false };
    expect(withStructuredContentText(result)).toBe(result);
  });

  test("oversized structured data is bounded like any other result", () => {
    const records = Array.from({ length: 5000 }, (_, i) => ({
      id: String(i),
      vendor: `Acme Supplier ${i}`,
      amount: "100.00",
    }));
    const text = extractTextForModel(withStructuredContentText(summaryOnly({ records })).content);
    expect(text.length).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
    const bounded = boundToolResultForModel(text);
    expect(bounded.length).toBeLessThan(text.length);
    expect(bounded).toContain("[Result bounded for model context");
  });
});
