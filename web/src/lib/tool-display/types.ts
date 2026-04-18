/**
 * Contracts for the tool-display layer.
 *
 * These are the types that describe what the UI renders — derived by the
 * describer from raw `ToolCallDisplay` data. The React layer never touches
 * raw tool-call data directly; it only consumes these shapes.
 */

/**
 * Display tone for a tool call. `running` drives the present-tense verb and
 * the spinner icon; `ok` / `error` are the terminal states. The accordion
 * handles all three — there is no separate live-state surface.
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

/** A batch of tool calls (one assistant turn's worth), described for display. */
export interface BatchDescription {
  /** Prose phrase with article (e.g. "Edited the document"). */
  verbPhrase: string;
  tone: Tone;
  items: ToolDescription[];
  totalMs: number | null;
}
