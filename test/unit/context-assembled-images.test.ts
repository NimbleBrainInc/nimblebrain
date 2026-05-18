/**
 * Integration-ish regression for the pre-flight `context.assembled` snapshot:
 * when a user turn carries one or more image attachments (rehydrated `file`
 * parts with `data: Uint8Array(<bytes>)`), `history.tokens` and the rollup
 * `totalTokens` must report plausible counts — not the millions reported by
 * the pre-fix `approxTokens(JSON.stringify(m))` code path.
 *
 * Anchor: prod conversation reported `totalTokens: 2,853,357` for a single
 * user turn with two PNG attachments (207KB + 711KB). Anthropic's `usage`
 * for the same turn returned `inputTokens: 51,364`. The two numbers should
 * be in the same order of magnitude (the estimator is allowed to differ from
 * the provider's count, but not by 50×).
 */

import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import { buildContextAssembledPayload } from "../../src/runtime/runtime.ts";

function makePngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("context.assembled — image-attached message regression", () => {
  test("two large PNG attachments → history < 10K tokens (was 2.8M pre-fix)", () => {
    // Reproduce the prod scenario: two rehydrated PNG file parts, total
    // ~918KB of binary payload, plus a short text caption.
    const a = new Uint8Array(207_007);
    a.set(makePngWithDimensions(1024, 768), 0);
    const b = new Uint8Array(711_000);
    b.set(makePngWithDimensions(2400, 1800), 0);
    const messages: LanguageModelV3Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at these screenshots — what's broken?" },
          { type: "file", mediaType: "image/png", data: a, filename: "before.png" },
          { type: "file", mediaType: "image/png", data: b, filename: "after.png" },
        ],
      },
    ];

    const payload = buildContextAssembledPayload({
      systemPrompt: "you are a helpful agent",
      activeTools: [],
      messages,
      skillsLoaded: { skills: [], totalTokens: 0 },
    });

    const historySource = payload.sources.find((s) => s.kind === "history");
    expect(historySource).toBeDefined();
    expect(historySource!.tokens).toBeLessThan(10_000);
    expect(payload.totalTokens).toBeLessThan(10_000);
    // Sanity: tokens are still positive (we want a real estimate, not zero).
    expect(historySource!.tokens).toBeGreaterThan(0);
  });

  test("text-only history is unaffected — heuristic identical for text parts", () => {
    const messages: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    const payload = buildContextAssembledPayload({
      systemPrompt: "system",
      activeTools: [],
      messages,
      skillsLoaded: { skills: [], totalTokens: 0 },
    });
    // Both messages are short text; total tokens should be < 20.
    const history = payload.sources.find((s) => s.kind === "history")!;
    expect(history.tokens).toBeGreaterThan(0);
    expect(history.tokens).toBeLessThan(20);
  });
});
