import { describe, expect, it } from "bun:test";
import { parseToolResult } from "../src/api/tool-result";
import type { ToolCallResult } from "../src/types";

describe("parseToolResult", () => {
  it("throws with the human-readable text when isError is true", () => {
    const res: ToolCallResult = {
      isError: true,
      content: [{ type: "text", text: "tool_not_found" }],
    };
    expect(() => parseToolResult(res)).toThrow("tool_not_found");
  });

  it("falls back to a generic message when isError is true with no text", () => {
    const res: ToolCallResult = {
      isError: true,
      content: [],
    };
    expect(() => parseToolResult(res)).toThrow("Operation failed");
  });

  it("prefers structuredContent over text when both are present", () => {
    const res: ToolCallResult = {
      isError: false,
      structuredContent: { foo: "bar", n: 7 },
      content: [{ type: "text", text: '{"different": "payload"}' }],
    };
    expect(parseToolResult<{ foo: string; n: number }>(res)).toEqual({
      foo: "bar",
      n: 7,
    });
  });

  it("JSON-parses content[0].text when structuredContent is absent", () => {
    const res: ToolCallResult = {
      isError: false,
      content: [{ type: "text", text: '{"users":[{"id":"u1"}]}' }],
    };
    expect(parseToolResult<{ users: { id: string }[] }>(res)).toEqual({
      users: [{ id: "u1" }],
    });
  });

  it("throws with the raw text when content text is not JSON", () => {
    const res: ToolCallResult = {
      isError: false,
      content: [{ type: "text", text: "definitely not json" }],
    };
    expect(() => parseToolResult(res)).toThrow("definitely not json");
  });

  it("throws when the response is empty", () => {
    const res: ToolCallResult = {
      isError: false,
      content: [],
    };
    expect(() => parseToolResult(res)).toThrow("Empty tool response");
  });
});
