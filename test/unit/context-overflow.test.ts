import { describe, expect, it } from "bun:test";
import { isContextOverflowError } from "../../src/engine/context-overflow.ts";

describe("isContextOverflowError", () => {
  it("matches Anthropic's prompt-too-long error", () => {
    const err = Object.assign(new Error("prompt is too long: 1257504 tokens > 1000000 maximum"), {
      status: 400,
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches OpenAI's maximum-context-length error", () => {
    const err = Object.assign(
      new Error(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens.",
      ),
      { status: 400 },
    );
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches Google Gemini's input-token-count error", () => {
    const err = Object.assign(
      new Error("The input token count exceeds the maximum number of tokens allowed (1000000)."),
      { status: 400 },
    );
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches a context-length-exceeded shape via responseBody", () => {
    const err = {
      status: 400,
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: { message: "context length exceeded", type: "invalid_request_error" },
      }),
    };
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("unwraps nested causes (Vercel AI SDK pattern)", () => {
    const inner = Object.assign(new Error("prompt is too long: 1.2M tokens > 1M maximum"), {
      status: 400,
    });
    const outer = Object.assign(new Error("AI_APICallError"), { status: 400, cause: inner });
    expect(isContextOverflowError(outer)).toBe(true);
  });

  it("returns false for unrelated 400s", () => {
    const err = Object.assign(new Error("Invalid model id 'foo'"), { status: 400 });
    expect(isContextOverflowError(err)).toBe(false);
  });

  it("returns false for non-4xx errors even if the message hints at length", () => {
    const err = Object.assign(new Error("prompt is too long for cache"), { status: 500 });
    expect(isContextOverflowError(err)).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError("string error")).toBe(false);
    expect(isContextOverflowError(404)).toBe(false);
  });

  it("matches when status is absent but message is unambiguous", () => {
    // Some upstream wrappers strip status; the message alone is enough.
    const err = new Error("prompt is too long: 1.5M tokens > 1M maximum");
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("is case-insensitive on the message", () => {
    const err = Object.assign(new Error("PROMPT IS TOO LONG: huge"), { status: 400 });
    expect(isContextOverflowError(err)).toBe(true);
  });
});
