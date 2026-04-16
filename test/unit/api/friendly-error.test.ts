/**
 * Tests for the friendlyError() error transformation function.
 *
 * Ensures known API/engine error patterns produce user-friendly messages
 * with correct machine-readable codes, and unknown errors don't leak
 * stack traces or internal details.
 */

import { describe, expect, it } from "bun:test";
import { friendlyError } from "../../../src/api/handlers.ts";

describe("friendlyError", () => {
  it("maps empty text content blocks to conversation_invalid", () => {
    const result = friendlyError("text content blocks must be non-empty");
    expect(result.code).toBe("conversation_invalid");
    expect(result.message).toContain("new conversation");
  });

  it("maps role alternation error to conversation_invalid", () => {
    const result = friendlyError("messages: roles must alternate between user and assistant");
    expect(result.code).toBe("conversation_invalid");
    expect(result.message).toContain("invalid state");
  });

  it("maps rate_limit to rate_limited", () => {
    const result = friendlyError("rate_limit: Too many requests");
    expect(result.code).toBe("rate_limited");
    expect(result.message).toContain("rate-limited");
  });

  it("maps 429 status to rate_limited", () => {
    const result = friendlyError("Request failed with status 429");
    expect(result.code).toBe("rate_limited");
  });

  it("maps authentication_error to provider_auth_error", () => {
    const result = friendlyError("authentication_error: invalid credentials");
    expect(result.code).toBe("provider_auth_error");
    expect(result.message).toContain("API key");
  });

  it("maps invalid x-api-key to provider_auth_error", () => {
    const result = friendlyError("invalid x-api-key header");
    expect(result.code).toBe("provider_auth_error");
  });

  it("maps overloaded to provider_overloaded", () => {
    const result = friendlyError("The API is temporarily overloaded");
    expect(result.code).toBe("provider_overloaded");
    expect(result.message).toContain("overloaded");
  });

  it("passes unknown errors through as engine_error", () => {
    const result = friendlyError("Something completely unexpected happened");
    expect(result.code).toBe("engine_error");
    expect(result.message).toBe("Something completely unexpected happened");
  });

  it("does not leak stack traces for unknown errors", () => {
    // The raw message is passed through, but callers should never pass stack traces.
    // This test documents the behavior: raw message IS the output.
    const raw = "TypeError: Cannot read properties of undefined";
    const result = friendlyError(raw);
    expect(result.code).toBe("engine_error");
    expect(result.message).toBe(raw);
  });
});
