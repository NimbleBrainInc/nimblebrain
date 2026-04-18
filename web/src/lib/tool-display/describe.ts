/**
 * Generic describer — Tier 0.
 *
 * Transforms raw `ToolCallDisplay` data into `ToolDescription` / `BatchDescription`
 * shapes that the UI consumes. Pure, side-effect free, deterministic.
 *
 * This is the fallback that runs for every tool call that doesn't have a
 * custom `ToolRenderer` registered. Apps opt into richer rendering by
 * registering at the registry; nothing here needs to change for them to
 * upgrade.
 */

import type { ToolCallDisplay, ToolResultForUI } from "../../hooks/useChat.ts";
import { stripServerPrefix } from "../format.ts";
import { findRenderer } from "./registry.ts";
import type { BatchDescription, InputField, Tone, ToolDescription } from "./types.ts";
import { dominantVerb, inferVerb, phraseFor } from "./verbs.ts";

/** Max characters for an inline "short" value; longer values render as <pre>. */
const SHORT_VALUE_MAX = 80;

/** Keys that make good one-line summaries, in preference order. */
const SUMMARY_KEYS: ReadonlyArray<string> = [
  "query",
  "q",
  "prompt",
  "message",
  "text",
  "content",
  "topic",
  "subject",
  "target",
  "term",
  "keyword",
  "name",
  "title",
  "path",
  "url",
  "uri",
  "id",
  "source",
  "code",
  "body",
];

/**
 * Describe one tool call. Checks the renderer registry first so custom
 * renderers (Tier 3) take precedence over the generic path.
 */
export function describeCall(call: ToolCallDisplay): ToolDescription {
  const custom = findRenderer(call.name);
  if (custom) return custom.describe(call);
  return genericDescribe(call);
}

/** Describe a batch of calls from a single assistant turn. */
export function describeBatch(calls: ReadonlyArray<ToolCallDisplay>): BatchDescription {
  const items = calls.map(describeCall);
  const tone = aggregateTone(items);
  const verbPhrase = batchPhrase(items, tone);
  const totalMs = sumDurations(items);
  return { verbPhrase, tone, items, totalMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic (Tier 0) describer — internal
// ─────────────────────────────────────────────────────────────────────────────

function genericDescribe(call: ToolCallDisplay): ToolDescription {
  const name = stripServerPrefix(call.name);
  const tone = toneFromStatus(call);
  const { verb, object } = inferVerb(name);
  const summary = summarizeInput(call.input);
  const headSubject = extractHeadSubject(call.input);
  const input = describeInput(call.input);
  const resultText = extractResultText(call.result);
  const resultJson = extractResultJson(call.result);
  const errorText = tone === "error" ? extractErrorText(call.result) : null;
  const durationMs = typeof call.ms === "number" ? call.ms : null;

  return {
    id: call.id,
    name,
    verb,
    object,
    tone,
    summary,
    headSubject,
    input,
    resultText,
    resultJson,
    errorText,
    durationMs,
  };
}

function toneFromStatus(call: ToolCallDisplay): Tone {
  if (call.status === "running") return "running";
  if (call.status === "error" || call.ok === false) return "error";
  if (call.result?.isError) return "error";
  return "ok";
}

/**
 * Aggregate per-call tones into a batch tone.
 *   any running → running  (the spinner wins — show live state)
 *   any error   → error    (honest failure signal)
 *   otherwise   → ok
 */
function aggregateTone(items: ReadonlyArray<ToolDescription>): Tone {
  if (items.some((it) => it.tone === "running")) return "running";
  if (items.some((it) => it.tone === "error")) return "error";
  return "ok";
}

/**
 * Pick the batch verb phrase. Use dominant verb across calls, pair with the
 * object from the first call that used that verb. On error tone, swap for
 * the "Couldn't X" phrasing.
 */
function batchPhrase(items: ReadonlyArray<ToolDescription>, tone: Tone): string {
  if (items.length === 0) return "";
  const verbs = items.map((it) => it.verb);
  const verb = dominantVerb(verbs);
  const firstWithVerb = items.find((it) => it.verb === verb);
  const object = firstWithVerb?.object ?? "";
  return phraseFor(verb, object, tone);
}

function sumDurations(items: ReadonlyArray<ToolDescription>): number | null {
  let hasAny = false;
  let total = 0;
  for (const it of items) {
    if (typeof it.durationMs === "number") {
      hasAny = true;
      total += it.durationMs;
    }
  }
  return hasAny ? total : null;
}

/**
 * Extract a short, standalone subject for inlining next to the verb phrase.
 * Returns just the value (not "key: value") from the best-priority string-ish
 * input key, when the input is simple enough to justify promoting it to the
 * head.
 *
 * Resolution order:
 *   1. First key from SUMMARY_KEYS present in input, if its value is a string.
 *   2. If input has exactly one string-valued key, use that — covers tools
 *      with app-specific argument names we can't enumerate.
 *   3. Otherwise null.
 */
function extractHeadSubject(input?: Record<string, unknown>): string | null {
  if (!input) return null;

  // 1: priority list
  const priorityKey = SUMMARY_KEYS.find((k) => typeof input[k] === "string");
  if (priorityKey) return clampSubject(input[priorityKey] as string);

  // 2: single string-valued key
  const stringKeys = Object.entries(input).filter(([, v]) => typeof v === "string");
  if (stringKeys.length === 1) return clampSubject(stringKeys[0][1] as string);

  return null;
}

function clampSubject(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const limit = 40;
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

/** Priority-key one-line input summary ("query: latest AI news"). */
function summarizeInput(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  const keys = Object.keys(input);
  if (keys.length === 0) return null;
  const key = SUMMARY_KEYS.find((k) => k in input) ?? keys[0];
  const raw = input[key];
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw : JSON.stringify(raw);
  const collapsed = str.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const preview =
    collapsed.length > SHORT_VALUE_MAX ? `${collapsed.slice(0, SHORT_VALUE_MAX)}…` : collapsed;
  return `${key}: ${preview}`;
}

/** Flatten input args into display-ready fields. */
function describeInput(input?: Record<string, unknown>): InputField[] {
  if (!input) return [];
  return Object.entries(input).map(([key, value]) => {
    const display = stringifyForDisplay(value);
    const kind = display.length > SHORT_VALUE_MAX || display.includes("\n") ? "long" : "short";
    return { key, display, kind };
  });
}

function stringifyForDisplay(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** First text block from MCP `content[]`. */
function extractResultText(result: ToolResultForUI | undefined): string | null {
  if (!result) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

/** Full result payload, pretty-printed, for the "raw" reveal. */
function extractResultJson(result: ToolResultForUI | undefined): string | null {
  if (!result) return null;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return null;
  }
}

/** For failed calls, surface the tool's error text (usually in content[0].text). */
function extractErrorText(result: ToolResultForUI | undefined): string | null {
  const text = extractResultText(result);
  return text && text.trim().length > 0 ? text : null;
}
