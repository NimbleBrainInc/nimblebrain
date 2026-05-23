/**
 * Tests for `src/engine/token-estimate.ts` — the part-aware pre-flight token
 * estimator that replaced `approxTokens(JSON.stringify(message))`.
 *
 * Regression anchor: a `file` part with `data: new Uint8Array(207_007)`
 * (an actual user-attached PNG size) must NOT inflate to 600K+ tokens.
 * The old formula reported ~620K tokens for that byte count, vs Anthropic's
 * actual ~1.3K image tokens — a 500× phantom-count inflation that triggered
 * spurious compaction and corrupted cost dashboards.
 */

import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import {
  estimateMessageTokens,
  estimateToolDescriptionTokens,
  imageTokensFromDimensions,
} from "../../src/engine/token-estimate.ts";
import type { ToolSchema } from "../../src/engine/types.ts";

/** Build a minimal 1×1 PNG byte buffer so dimension decoding hits the PNG branch. */
function makeTinyPng(): Uint8Array {
  // Hand-rolled valid PNG signature + IHDR with 1×1 dimensions. We don't
  // need IDAT data — the dimension decoder only reads the IHDR header.
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR chunk length (13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  // width=1, height=1 (big-endian uint32s at offsets 16, 20).
  bytes.set([0x00, 0x00, 0x00, 0x01], 16);
  bytes.set([0x00, 0x00, 0x00, 0x01], 20);
  return bytes;
}

/** Build a valid PNG header with caller-supplied dimensions. */
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

describe("estimateMessageTokens — text-only", () => {
  test("user message with a single text part — tokens scale with text length", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    };
    // "hello world" is 11 chars → ceil(11/4) = 3 tokens.
    expect(estimateMessageTokens(msg)).toBe(3);
  });

  test("system message — content is a bare string", () => {
    const msg: LanguageModelV3Message = {
      role: "system",
      content: "you are a helpful agent",
    };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil("you are a helpful agent".length / 4));
  });

  test("empty user content — zero tokens, no throw", () => {
    const msg: LanguageModelV3Message = { role: "user", content: [] };
    expect(estimateMessageTokens(msg)).toBe(0);
  });
});

describe("estimateMessageTokens — image regression", () => {
  test("REGRESSION: 207KB Uint8Array PNG-headered data does NOT inflate to 600K+ tokens", () => {
    // The reported prod conversation had a 207,007-byte PNG attachment.
    // Pre-fix: `approxTokens(JSON.stringify(msg))` reported ~620K phantom
    // tokens; provider charged ~1.3K. We require the new estimator to stay
    // well under 10K for this case.
    const bytes = makePngWithDimensions(1024, 768);
    // Tail-pad to ~207KB so the actual byte count matches prod, but the
    // PNG header still decodes to 1024×768. The decoder only reads the
    // IHDR header; padding bytes are ignored.
    const padded = new Uint8Array(207_007);
    padded.set(bytes, 0);
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: padded, filename: "screenshot.png" }],
    };
    const tokens = estimateMessageTokens(msg);
    // 1024×768 = 786,432 pixels; 786,432/750 = 1049 → clamped to [800, 1600].
    expect(tokens).toBeLessThan(10_000);
    expect(tokens).toBeGreaterThan(0);
  });

  test("REGRESSION: 711KB Uint8Array PNG with large dims clamps at 1600 tokens", () => {
    // The 711KB prod attachment was a high-resolution screenshot. A
    // 4000×3000 image (12M pixels) would naively give 16K tokens; Anthropic
    // clamps at 1600 and we must too.
    const bytes = makePngWithDimensions(4000, 3000);
    const padded = new Uint8Array(711_000);
    padded.set(bytes, 0);
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: padded }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(1600);
  });

  test("REGRESSION: two large PNG attachments combined < 10K tokens (was 2.8M pre-fix)", () => {
    // The exact prod scenario: two attached PNGs in one user turn. Prod
    // reported `totalTokens: 2,853,357` for this case.
    const a = new Uint8Array(207_007);
    a.set(makePngWithDimensions(1024, 768), 0);
    const b = new Uint8Array(711_000);
    b.set(makePngWithDimensions(2400, 1800), 0);
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [
        { type: "text", text: "Look at these screenshots" },
        { type: "file", mediaType: "image/png", data: a, filename: "a.png" },
        { type: "file", mediaType: "image/png", data: b, filename: "b.png" },
      ],
    };
    expect(estimateMessageTokens(msg)).toBeLessThan(10_000);
  });

  test("image without a recognizable header falls back to flat estimate", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [
        { type: "file", mediaType: "image/png", data: new Uint8Array(200_000) },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // Flat fallback is inside the Anthropic [800, 1600] clamp range.
    expect(tokens).toBeGreaterThanOrEqual(800);
    expect(tokens).toBeLessThanOrEqual(1600);
  });

  test("imageTokensFromDimensions honors the [800, 1600] clamp", () => {
    // Tiny image: raw formula would give 1 token; must clamp up to 800.
    expect(imageTokensFromDimensions(10, 10)).toBe(800);
    // Huge image: raw formula gives 1M+ tokens; must clamp down to 1600.
    expect(imageTokensFromDimensions(10_000, 10_000)).toBe(1600);
    // Mid-range: stays in band. 1024×1024 / 750 = 1399.
    expect(imageTokensFromDimensions(1024, 1024)).toBe(1399);
  });
});

describe("estimateMessageTokens — non-image files", () => {
  test("PDF attachment is tokenized as metadata, not bytes", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/pdf",
          data: new Uint8Array(5_000_000),
          filename: "report.pdf",
        },
      ],
    };
    // mediaType (15) + filename (10) = 25 chars / 4 = 7, plus 50 overhead.
    // The 5MB byte payload must NOT influence the count.
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeLessThan(100);
  });
});

describe("estimateMessageTokens — tool-call parts", () => {
  test("tool-call serializes input args, not surrounding shell", () => {
    const msg: LanguageModelV3Message = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "search",
          input: { query: "what is the weather in tokyo today" },
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(50); // includes overhead
    expect(tokens).toBeLessThan(100);
  });

  test("tool-call with nested object args", () => {
    const msg: LanguageModelV3Message = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "fetch",
          input: { url: "https://example.com", headers: { auth: "bearer abc", trace: "x-id" } },
        },
      ],
    };
    expect(estimateMessageTokens(msg)).toBeGreaterThan(50);
  });
});

describe("estimateMessageTokens — tool-result parts", () => {
  test("text output is tokenized straightforwardly", () => {
    const msg: LanguageModelV3Message = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "search",
          output: { type: "text", value: "sunny, 72F" },
        },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil("sunny, 72F".length / 4));
  });

  test("nested file-data with image media type uses image token estimate, not byte length", () => {
    // Tool-result `content` arrays can carry `file-data` blocks with
    // base64-encoded bytes. The naive `JSON.stringify` path would tokenize
    // the entire base64 string as text; we must use the image estimate.
    //
    // Build a fake base64 string ~700KB long — what a real image would
    // serialize to — and verify the estimator stays inside the image
    // clamp rather than reporting ~175K tokens (700K/4).
    const fakeBase64 = "A".repeat(700_000);
    const msg: LanguageModelV3Message = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "snapshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "screenshot taken" },
              { type: "file-data", data: fakeBase64, mediaType: "image/png", filename: "out.png" },
            ],
          },
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // Image flat fallback (~1300) + tiny text ("screenshot taken" ~5 tokens).
    // The base64 payload's 700K chars must NOT contribute.
    expect(tokens).toBeLessThan(2_000);
  });

  test("json output is tokenized by serialized length", () => {
    const msg: LanguageModelV3Message = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "lookup",
          output: { type: "json", value: { ok: true, count: 7 } },
        },
      ],
    };
    expect(estimateMessageTokens(msg)).toBeGreaterThan(0);
  });
});

describe("estimateMessageTokens — reasoning parts", () => {
  test("reasoning text contributes its char-count tokens", () => {
    const msg: LanguageModelV3Message = {
      role: "assistant",
      content: [{ type: "reasoning", text: "let me think about this carefully" }],
    };
    expect(estimateMessageTokens(msg)).toBe(
      Math.ceil("let me think about this carefully".length / 4),
    );
  });
});

describe("estimateMessageTokens — tiny PNG dimension decoding", () => {
  test("decodes 1×1 PNG header and applies the clamp", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: makeTinyPng() }],
    };
    // 1×1 pixels → ceil(1/750) = 1 → clamped up to 800.
    expect(estimateMessageTokens(msg)).toBe(800);
  });
});

describe("estimateToolDescriptionTokens", () => {
  test("scales with name + description + schema text length", () => {
    const tool: ToolSchema = {
      name: "search_web",
      description: "Search the public web and return ranked results.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const tokens = estimateToolDescriptionTokens(tool);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(200);
  });

  test("handles missing description / schema without throw", () => {
    const tool: ToolSchema = {
      name: "noop",
      description: "",
      inputSchema: {},
    };
    expect(estimateToolDescriptionTokens(tool)).toBeGreaterThanOrEqual(0);
  });
});
