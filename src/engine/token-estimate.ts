/**
 * Part-aware pre-flight token estimator for `LanguageModelV3Message`s and
 * tool schemas.
 *
 * The naive `approxTokens(JSON.stringify(m))` inflates by 30-100× whenever a
 * message carries a `file` part with `data: Uint8Array(<bytes>)`:
 * `JSON.stringify(Uint8Array)` produces `{"0":n,"1":n,...}` (~12 chars/byte),
 * and `approxTokens = ceil(len/4)` then over-counts by ~3 tokens per byte.
 * For a 700KB-class PNG this is ~2.1M phantom tokens vs the ~1.3K tokens the
 * provider actually charges.
 *
 * The fix walks each content part and uses a part-appropriate estimator:
 *   - text: `ceil(text.length / 4)` (the current heuristic, correct for text)
 *   - image file: Anthropic's documented formula `ceil((w*h) / 750)` clamped
 *     to [800, 1600] when dimensions are decodable; flat 1300-token fallback
 *     otherwise.  (https://docs.anthropic.com/en/docs/build-with-claude/vision)
 *   - non-image file: tokenize only the metadata (mediaType + filename) that
 *     actually gets relayed, plus a small overhead.
 *   - tool-call / tool-result: tokenize structured args/output without
 *     `JSON.stringify`-ing any embedded binary.
 *   - reasoning: tokenize the text.
 *
 * Results are an estimate; the truth lives on `llm.response.usage` after the
 * call returns. Pre-flight is for iteration-loop decisions (compaction,
 * max-input gating).
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { ToolSchema } from "./types.ts";

/** Anthropic vision tokens-per-pixel divisor and clamp bounds. */
const IMAGE_TOKENS_PER_PIXEL_DIVISOR = 750;
const IMAGE_TOKEN_MIN = 800;
const IMAGE_TOKEN_MAX = 1600;
/**
 * Fallback used when image dimensions can't be decoded from the bytes (no
 * `image-size` dep is bundled today). Sits inside the [800, 1600] clamp
 * range so over/underestimate is bounded.
 * TODO: decode dimensions when an `image-size`-style helper is available.
 * See https://docs.anthropic.com/en/docs/build-with-claude/vision for the
 * provider-side formula this approximates.
 */
const IMAGE_TOKEN_FALLBACK = 1300;
const FILE_METADATA_OVERHEAD_TOKENS = 50;
const TOOL_CALL_OVERHEAD_TOKENS = 50;

function tokensForChars(len: number): number {
  return Math.ceil(len / 4);
}

function tokensForText(text: string | undefined | null): number {
  if (!text) return 0;
  return tokensForChars(text.length);
}

/** Decoded pixel dimensions for a raster image. */
type ImageDimensions = { width: number; height: number };

/** PNG dimensions from the IHDR chunk (big-endian uint32s at offsets 16 and 20), or null if not a PNG. */
function decodePngDimensions(data: Uint8Array): ImageDimensions | null {
  // PNG: 8-byte signature + IHDR chunk; width/height live at offsets 16..23
  // as big-endian uint32s.
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a &&
    data.length >= 24
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  return null;
}

/** GIF87a/GIF89a dimensions (little-endian uint16s at offsets 6 and 8), or null if not a GIF. */
function decodeGifDimensions(data: Uint8Array): ImageDimensions | null {
  // GIF87a / GIF89a: signature + LE width/height at offsets 6..9.
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data.length >= 10) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  return null;
}

/** WebP dimensions across VP8/VP8L/VP8X chunk shapes, or null if not a WebP or an unknown chunk. */
function decodeWebpDimensions(data: Uint8Array): ImageDimensions | null {
  // WebP (RIFF....WEBP): VP8/VP8L/VP8X dimensions vary by chunk type.
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50 &&
    data.length >= 30
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const fourCC = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!);
    if (fourCC === "VP8 ") {
      // Lossy: 14-bit width/height at offsets 26..29 (little-endian, low 14 bits).
      const w = view.getUint16(26, true) & 0x3fff;
      const h = view.getUint16(28, true) & 0x3fff;
      return { width: w, height: h };
    }
    if (fourCC === "VP8L") {
      // Lossless: bits-packed at offset 21; 14-bit width then 14-bit height.
      const b0 = data[21]!;
      const b1 = data[22]!;
      const b2 = data[23]!;
      const b3 = data[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
    if (fourCC === "VP8X" && data.length >= 30) {
      // Extended: 24-bit width-1 + 24-bit height-1 at offsets 24..29.
      const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
      const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
      return { width, height };
    }
  }
  return null;
}

/** True for JPEG SOF markers (0xC0..0xCF) that carry dimensions, excluding DHT/JPG/DAC (C4/C8/CC). */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** JPEG dimensions from the first SOF marker found while scanning segments, or null if none. */
function decodeJpegDimensions(data: Uint8Array): ImageDimensions | null {
  // JPEG: scan SOF0..SOF3 markers for height/width. Cheap enough at this size.
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < data.length - 9) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1]!;
    if (isSofMarker(marker)) {
      if (offset + 9 >= data.length) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      return { width, height };
    }
    const segLen = (data[offset + 2]! << 8) | data[offset + 3]!;
    offset += 2 + segLen;
  }
  return null;
}

/**
 * PNG / JPEG / GIF / WebP dimension decode from the in-memory bytes. Returns
 * null on any short read or unrecognized header — the caller falls back to
 * the flat per-image estimate. Pure-byte parsing rather than a dep so the
 * estimator stays self-contained.
 *
 * Only the four formats Anthropic vision accepts are supported. The `< 12`
 * guard gates every format (including GIF's 10-byte minimum) before dispatch.
 */
function decodeImageDimensions(data: Uint8Array): ImageDimensions | null {
  if (data.length < 12) return null;
  return (
    decodePngDimensions(data) ??
    decodeGifDimensions(data) ??
    decodeWebpDimensions(data) ??
    decodeJpegDimensions(data)
  );
}

/**
 * Anthropic's vision token formula: `ceil((width * height) / 750)`, clamped
 * to [800, 1600] tokens. Matches the provider-side accounting per
 * https://docs.anthropic.com/en/docs/build-with-claude/vision.
 */
export function imageTokensFromDimensions(width: number, height: number): number {
  const raw = Math.ceil((width * height) / IMAGE_TOKENS_PER_PIXEL_DIVISOR);
  if (raw < IMAGE_TOKEN_MIN) return IMAGE_TOKEN_MIN;
  if (raw > IMAGE_TOKEN_MAX) return IMAGE_TOKEN_MAX;
  return raw;
}

function tokensForImageFilePart(part: LanguageModelV3FilePart): number {
  // `data` may be Uint8Array, base64 string, or URL. We only attempt decode
  // for bytes; the other shapes get the flat fallback. The fallback sits
  // inside the [800, 1600] Anthropic clamp so we never overpay by an order
  // of magnitude regardless of dimensions.
  if (part.data instanceof Uint8Array) {
    const dims = decodeImageDimensions(part.data);
    if (dims && dims.width > 0 && dims.height > 0) {
      return imageTokensFromDimensions(dims.width, dims.height);
    }
  }
  return IMAGE_TOKEN_FALLBACK;
}

function tokensForFilePart(part: LanguageModelV3FilePart): number {
  if (part.mediaType.startsWith("image/")) {
    return tokensForImageFilePart(part);
  }
  // Non-image files are surfaced to the model as metadata (the file itself
  // is fetched via a separate `files__read` tool round-trip when needed),
  // so we tokenize that metadata, not the bytes.
  const metaLen = (part.mediaType?.length ?? 0) + (part.filename?.length ?? 0);
  return tokensForChars(metaLen) + FILE_METADATA_OVERHEAD_TOKENS;
}

function tokensForToolCallPart(part: LanguageModelV3ToolCallPart): number {
  // `JSON.stringify(undefined)` returns undefined; default to "{}" for
  // shape-only calls. Args are JSON-encoded by the provider — chars/4 is the
  // same heuristic the provider's tokenizer approximates.
  const inputJson = part.input === undefined ? "{}" : JSON.stringify(part.input);
  const nameLen = part.toolName?.length ?? 0;
  return tokensForChars(inputJson.length + nameLen) + TOOL_CALL_OVERHEAD_TOKENS;
}

/** Elements of a tool-result `content` output's `value` array. */
type ToolResultContentValue = Extract<
  LanguageModelV3ToolResultPart["output"],
  { type: "content" }
>["value"];
type ToolResultContentItem = ToolResultContentValue[number];

/** Tokens for one tool-result content item, walking file/image shapes without `JSON.stringify`-ing bytes. */
function tokensForToolResultContentItem(item: ToolResultContentItem): number {
  switch (item.type) {
    case "text":
      return tokensForText(item.text);
    case "file-data":
      // Base64-encoded image: same flat fallback as the file-part path (we
      // don't decode dimensions from the b64 wire shape) so over/underestimate
      // is bounded. Non-image: tokenize only the relayed metadata.
      return item.mediaType.startsWith("image/")
        ? IMAGE_TOKEN_FALLBACK
        : tokensForChars(item.mediaType.length + (item.filename?.length ?? 0)) +
            FILE_METADATA_OVERHEAD_TOKENS;
    case "file-url":
    case "file-id": {
      // Reference-only; tokenize the small pointer. Neither shape carries
      // `mediaType` in the V3 union, so cost is dominated by the overhead.
      const ref = "url" in item ? item.url : JSON.stringify(item.fileId);
      return tokensForChars(ref.length) + FILE_METADATA_OVERHEAD_TOKENS;
    }
    case "image-data":
      return IMAGE_TOKEN_FALLBACK;
    default:
      return 0;
  }
}

/** Sum of per-item estimates across a tool-result `content` array, accumulated in array order. */
function tokensForToolResultContent(items: ToolResultContentValue): number {
  // The result's nested content array is itself a sequence of parts that can
  // contain inline `file-data` (base64) blocks; walk them so we never
  // `JSON.stringify` raw bytes.
  let sum = 0;
  for (const item of items) {
    sum += tokensForToolResultContentItem(item);
  }
  return sum;
}

function tokensForToolResultPart(part: LanguageModelV3ToolResultPart): number {
  const output = part.output;
  switch (output.type) {
    case "text":
    case "error-text":
      return tokensForText(output.value);
    case "json":
    case "error-json":
      return tokensForChars(JSON.stringify(output.value).length);
    case "execution-denied":
      return tokensForText(output.reason) + 5;
    case "content":
      return tokensForToolResultContent(output.value);
    default:
      return 0;
  }
}

function tokensForTextPart(part: LanguageModelV3TextPart): number {
  return tokensForText(part.text);
}

function tokensForReasoningPart(part: LanguageModelV3ReasoningPart): number {
  return tokensForText(part.text);
}

/**
 * Estimate input tokens for a single message. Walks `content` parts and
 * applies the part-appropriate estimator. Returns 0 for shapes we don't
 * recognize rather than throwing — this is a budget heuristic, not
 * validation.
 *
 * The role-header overhead (`<|user|>`, etc.) is small and constant per
 * message; we don't add a separate constant for it because Anthropic's
 * actual tokenizer rolls that into its system overhead, which we don't
 * try to model here. The conversation-store still has the truth from
 * `usage` after the call.
 */
export function estimateMessageTokens(message: LanguageModelV3Message): number {
  if (message.role === "system") {
    return tokensForText(message.content);
  }
  let sum = 0;
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        sum += tokensForTextPart(part);
        break;
      case "file":
        sum += tokensForFilePart(part);
        break;
      case "tool-call":
        sum += tokensForToolCallPart(part);
        break;
      case "tool-result":
        sum += tokensForToolResultPart(part);
        break;
      case "reasoning":
        sum += tokensForReasoningPart(part);
        break;
      // Other part types (tool-approval-response) carry only small flags;
      // ignore for budget purposes.
    }
  }
  return sum;
}

/**
 * Pre-flight estimate of the tokens a tool description will cost when
 * surfaced to the model. Mirrors the legacy formula (name + description +
 * input schema as text) but keeps `JSON.stringify` confined to the schema
 * object — which today is plain JSON but is shape-coupled to objects that
 * may eventually carry binary defaults, so we centralize the call site.
 */
export function estimateToolDescriptionTokens(tool: ToolSchema): number {
  const schemaText = JSON.stringify(tool.inputSchema ?? {});
  return tokensForChars(
    (tool.name?.length ?? 0) + 1 + (tool.description?.length ?? 0) + 1 + schemaText.length,
  );
}
