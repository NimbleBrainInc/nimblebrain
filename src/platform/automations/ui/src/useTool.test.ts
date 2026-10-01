/**
 * The host answers a tool's own failure as a result with `isError: true`.
 * This panel reports failures from `catch`, so the result must become a throw
 * carrying the tool's text, and a success must pass through untouched.
 */
import { describe, expect, it } from "bun:test";
import { throwIfToolError } from "./useTool.ts";

describe("throwIfToolError", () => {
  it("passes a success through", () => {
    const result = { data: { ok: true }, isError: false, content: [] };
    expect(throwIfToolError(result)).toBe(result);
  });

  it("throws a tool error with the tool's text", () => {
    const result = {
      data: "Automation not found",
      isError: true,
      content: [{ type: "text", text: "Automation not found" }],
    };
    expect(() => throwIfToolError(result)).toThrow("Automation not found");
  });

  it("throws a generic message when the error has no text", () => {
    expect(() => throwIfToolError({ data: null, isError: true, content: [] })).toThrow(
      "Tool error",
    );
  });
});
