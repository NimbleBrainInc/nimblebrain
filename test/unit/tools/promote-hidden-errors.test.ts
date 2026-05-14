import { describe, expect, it } from "bun:test";
import type { ToolResult } from "../../../src/engine/types.ts";
import { promoteHiddenErrors } from "../../../src/tools/promote-hidden-errors.ts";

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

describe("promoteHiddenErrors — promotes lies", () => {
  it("promotes Mercury-style 'Ran into an error' lies", () => {
    const result = textResult(
      "Ran into an error: AxiosError: Request failed with status code 400\nCommunicate this to the user and consider retrying if the error seems transient.\n",
      false,
    );
    const out = promoteHiddenErrors(result);
    expect(out.isError).toBe(true);
    expect(out.content).toBe(result.content); // content preserved
  });

  it("promotes plain AxiosError mentions anywhere in text", () => {
    const result = textResult("Something happened. AxiosError: nope.", false);
    expect(promoteHiddenErrors(result).isError).toBe(true);
  });

  it("promotes 'Request failed with status code 500' at line start", () => {
    const result = textResult("Request failed with status code 500", false);
    expect(promoteHiddenErrors(result).isError).toBe(true);
  });

  it("promotes generic 'Error: ... status code NNN' patterns", () => {
    const result = textResult("Error: HTTP request failed with status code 404", false);
    expect(promoteHiddenErrors(result).isError).toBe(true);
  });
});

describe("promoteHiddenErrors — leaves honest results alone", () => {
  it("does not change a clean success", () => {
    const result = textResult('{"transactions":[],"page":{"nextPage":null}}', false);
    const out = promoteHiddenErrors(result);
    expect(out).toBe(result); // same reference — no mutation
    expect(out.isError).toBe(false);
  });

  it("does not change an already-flagged error", () => {
    const result = textResult("Ran into an error: something", true);
    const out = promoteHiddenErrors(result);
    expect(out).toBe(result);
    expect(out.isError).toBe(true);
  });

  it("does not promote a result with no text content", () => {
    const result: ToolResult = {
      content: [
        {
          type: "image",
          data: "AAAA",
          mimeType: "image/png",
        },
      ],
      isError: false,
    };
    const out = promoteHiddenErrors(result);
    expect(out).toBe(result);
    expect(out.isError).toBe(false);
  });

  it("does not promote a benign string that happens to contain 'error'", () => {
    const result = textResult("The user had an error in their query string", false);
    expect(promoteHiddenErrors(result).isError).toBe(false);
  });

  it("does not promote a result discussing an error in past tense", () => {
    const result = textResult(
      "Successfully resolved the previous error. All operations completed.",
      false,
    );
    expect(promoteHiddenErrors(result).isError).toBe(false);
  });
});

describe("promoteHiddenErrors — multi-block content", () => {
  it("promotes when any block matches", () => {
    const result: ToolResult = {
      content: [
        { type: "text", text: "Initial summary." },
        { type: "text", text: "Ran into an error: AxiosError 400" },
      ],
      isError: false,
    };
    expect(promoteHiddenErrors(result).isError).toBe(true);
  });

  it("ignores non-text blocks while scanning", () => {
    const result: ToolResult = {
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "AxiosError 500" },
      ],
      isError: false,
    };
    expect(promoteHiddenErrors(result).isError).toBe(true);
  });
});

describe("promoteHiddenErrors — preserves shape", () => {
  it("preserves structuredContent when promoting", () => {
    const result: ToolResult = {
      content: [{ type: "text", text: "Ran into an error: x" }],
      structuredContent: { someField: 42 },
      isError: false,
    };
    const out = promoteHiddenErrors(result);
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toEqual({ someField: 42 });
  });
});
