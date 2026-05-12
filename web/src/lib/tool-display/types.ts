/**
 * Contracts for the tool-display layer.
 *
 * These are the types that describe what the UI renders — derived by the
 * describer from raw `ToolCallDisplay` data. The React layer never touches
 * raw tool-call data directly; it only consumes these shapes.
 */

import type { ToolCallDisplay } from "../../hooks/useChat.ts";

/**
 * Display tone for a single tool call. `running` drives the present-tense
 * verb and the spinner icon; `ok` / `error` are the terminal states.
 */
export type Tone = "ok" | "running" | "error";

export type DisplayDetail = "quiet" | "balanced" | "verbose";

/** A single input arg prepared for display. */
export interface InputField {
  key: string;
  /** Stringified, truncated, ready to render. */
  display: string;
  /** "long" values render as <pre>; "short" render inline. */
  kind: "short" | "long";
}

/** A single tool call, described for display. Tier 0 produces this generically. */
export interface ToolDescription {
  id: string;
  /** Name with server prefix stripped (e.g. "patch_source"). */
  name: string;
  /** Verb inferred from the name (e.g. "Edited"). */
  verb: string;
  /** Object inferred from the name (e.g. "source"). */
  object: string;
  tone: Tone;
  /**
   * Full "key: value" input preview, e.g. "query: latest AI news".
   * Used in expanded rows. Null when no useful summary.
   */
  summary: string | null;
  /**
   * Just the value portion of `summary` — useful for inlining next to the
   * verb phrase without repeating the key. For `{query: "foo"}` this is
   * "foo" (not "query: foo"). Null when there isn't a clean single-value
   * subject (e.g. input has many keys, or a nested object).
   */
  headSubject: string | null;
  input: InputField[];
  /** First MCP `content[].text` entry, if any. */
  resultText: string | null;
  /** Pretty-printed full result JSON, for diagnostics. */
  resultJson: string | null;
  /** Message for failed calls; null when successful. */
  errorText: string | null;
  durationMs: number | null;
}

/**
 * One entry in a turn's activity timeline.
 *
 * - `reasoning` rows surface model thinking inline with the tool activity.
 * - `tool` rows collapse every call of the same (stripped) tool name within
 *   the turn into a single group, regardless of how reasoning interleaves
 *   between them. The group sits at the position of its first call.
 */
export type TimelineEntry =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; calls: ReadonlyArray<ToolCallDisplay> };

/**
 * Turn-level summary used by the pill's L1 (collapsed) head. Derived from the
 * full set of tool calls in a turn; not coupled to streamingState — the pill
 * combines this with streamingState to choose its running-vs-done label.
 */
export interface TurnSummary {
  /** Past-tense dominant verb across all calls ("Researched"). */
  dominantVerb: string;
  /** Present-progressive form for use during streaming ("Researching"). */
  dominantVerbPresent: string;
  /** Headline subject when calls share one, otherwise null. */
  topSubject: string | null;
  /** Total number of tool calls in the turn (sum across groups). */
  totalCalls: number;
  /** Sum of per-call durations in ms, when any are known. */
  totalMs: number | null;
  /** True while any call is still running. */
  running: boolean;
}
