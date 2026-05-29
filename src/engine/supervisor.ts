import { createHash } from "node:crypto";
import { extractTextForModel, textContent } from "./content-helpers.ts";
import type { ToolCall, ToolResult } from "./types.ts";

/**
 * Per-run loop supervisor.
 *
 * Watches the per-call fingerprint of every tool result inside an engine
 * run. If a single tool returns the same fingerprint N times in a row,
 * the supervisor declares that tool stuck and replaces its next result
 * with a synthetic directive instructing the model to stop calling the
 * tool and produce a final response.
 *
 * Two failure modes this catches:
 *  - Upstream returns identical 4xx errors on every call (e.g. a tool
 *    whose schema-derived args trigger a deterministic server-side
 *    rejection). The model often retries with cosmetic argument tweaks
 *    and gets the same rejection each time.
 *  - Upstream returns identical "empty success" payloads to the same
 *    call (pagination dead-ends; idempotent lookups against an
 *    unchanged state).
 *
 * Fingerprint composition (success vs. error are different shapes of
 * "stuck"):
 *
 *  - SUCCESS: (toolName, S, content, canonical(input)).
 *    A successful call advances state; "stuck" means the model invoked
 *    the same call (same name + same input) and got the same answer
 *    back, repeatedly. Distinct inputs producing structurally-uniform
 *    success output (e.g. `patch_source(edits=...)` returning
 *    `applied:true, compiled:true` for each of several edits in a row)
 *    is progress, not a loop, and must not trip.
 *
 *  - ERROR: (toolName, E, content). Input is deliberately omitted so
 *    the "model retries-with-tweaks against a deterministic rejection"
 *    failure mode still trips at N repeats — the canonical case the
 *    supervisor was originally written to catch.
 *
 * Per-tool isolation: a stuck tool doesn't trip the supervisor on
 * unrelated tools. Reset-on-different-fingerprint preserves legitimate
 * adaptive retry behaviour (a tool that fails once with error A, then
 * once with error B, then succeeds, never trips).
 *
 * The supervisor itself never aborts the run; the engine reads the
 * verdict and decides what to surface. On a trip the engine also
 * filters the tripped tool out of the model's toolset for the rest of
 * the run, so the model can't call the broken tool again regardless of
 * how it reads the synth directive.
 */

export interface SupervisorConfig {
  /**
   * Number of consecutive identical-fingerprint results that triggers a
   * trip. Default 3 — first call is exploratory, second is "maybe a bad
   * arg," third confirms the tool is broken.
   */
  maxConsecutiveRepeats?: number;
  /**
   * Char cap on the content text included in the fingerprint hash. Default
   * 512. Caps fingerprint cost on pathologically large successful payloads
   * that would otherwise be hashed in full on every call.
   */
  fingerprintTextCap?: number;
}

export type SupervisorVerdict =
  | { type: "pass" }
  | {
      type: "synth";
      replacement: ToolResult;
      trippedTool: string;
      consecutiveRepeats: number;
    };

export interface SupervisorSnapshot {
  trippedTools: string[];
  callCounts: Record<string, number>;
}

export interface RunSupervisor {
  /**
   * Called after each tool result is finalised (post-hook, post-A.3
   * normalization). Returns the verdict the engine should act on.
   */
  observe(call: ToolCall, result: ToolResult): SupervisorVerdict;
  /** Telemetry snapshot. */
  snapshot(): SupervisorSnapshot;
}

interface ToolState {
  lastFingerprint: string | null;
  consecutiveRepeats: number;
  totalCalls: number;
  tripped: boolean;
}

const DEFAULT_MAX_REPEATS = 3;
const DEFAULT_FINGERPRINT_CAP = 512;

/**
 * Canonical (stable) JSON encoding for the supervisor's input-aware
 * success fingerprint. Object keys are sorted so that two semantically
 * identical inputs that arrived with different key orderings hash to
 * the same value; arrays preserve order (positional). Bypasses
 * `JSON.stringify`'s implementation-defined key order.
 *
 * Not a public utility — the supervisor only needs this for repeat
 * detection. Inputs are bounded upstream by the model's output limit,
 * so we don't cap here; if that ever changes, cap to `textCap` to
 * match the result-text policy.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function createRunSupervisor(config: SupervisorConfig = {}): RunSupervisor {
  const maxRepeats = config.maxConsecutiveRepeats ?? DEFAULT_MAX_REPEATS;
  const textCap = config.fingerprintTextCap ?? DEFAULT_FINGERPRINT_CAP;

  const states = new Map<string, ToolState>();

  function getState(toolName: string): ToolState {
    let s = states.get(toolName);
    if (!s) {
      s = { lastFingerprint: null, consecutiveRepeats: 0, totalCalls: 0, tripped: false };
      states.set(toolName, s);
    }
    return s;
  }

  function fingerprint(call: ToolCall, result: ToolResult): string {
    // Known limitation: hashing only the first `textCap` chars can
    // false-positive on tools that return a long stable preamble (e.g. a
    // verbose header) followed by a short varying field. Two semantically
    // distinct results may collapse to the same fingerprint and trip the
    // supervisor early. Addressable later by hashing head+tail or
    // structuredContent when present; out of scope here.
    const text = extractTextForModel(result.content).trim().slice(0, textCap);
    // Input is part of the fingerprint for SUCCESS results only — see the
    // file header for the rationale. Errors stay input-agnostic so the
    // "deterministic-4xx with retry-with-tweaks" loop still trips.
    const inputKey = result.isError ? "" : canonicalJson(call.input);
    return createHash("sha1")
      .update(`${call.name}\0${result.isError ? "E" : "S"}\0${text}\0${inputKey}`)
      .digest("hex");
  }

  function synthReplacement(toolName: string, originalText: string, repeats: number): ToolResult {
    // Wording note: this content persists in the conversation log across
    // future runs, so the message is scoped to *this* tool and phrased as a
    // record of what happened. No universal directives ("stop using tools",
    // "end the run") — those rot when reread in a later turn where other
    // tools are still callable.
    const directive =
      `[NB supervisor] Tool \`${toolName}\` returned the same result ${repeats} times in a row; ` +
      `this tool has been disabled for the rest of this run.\n\n` +
      `Underlying output (last call):\n${originalText}\n\n` +
      `Other tools remain available. Consider an alternative approach or summarize current findings ` +
      `if no path forward exists.`;
    return {
      content: textContent(directive),
      isError: true,
    };
  }

  function observe(call: ToolCall, result: ToolResult): SupervisorVerdict {
    const state = getState(call.name);
    state.totalCalls += 1;

    if (state.tripped) {
      // Once tripped, every subsequent call to the same tool keeps getting
      // the synthetic directive. In practice the engine drops tripped tools
      // from modelTools so the model can't call again — this branch is a
      // belt-and-suspenders fallback if a caller invokes the tool anyway.
      const originalText = extractTextForModel(result.content).trim();
      return {
        type: "synth",
        replacement: synthReplacement(call.name, originalText, state.consecutiveRepeats),
        trippedTool: call.name,
        consecutiveRepeats: state.consecutiveRepeats,
      };
    }

    const fp = fingerprint(call, result);
    if (fp === state.lastFingerprint) {
      state.consecutiveRepeats += 1;
    } else {
      state.consecutiveRepeats = 1;
      state.lastFingerprint = fp;
    }

    if (state.consecutiveRepeats >= maxRepeats) {
      state.tripped = true;
      const originalText = extractTextForModel(result.content).trim();
      return {
        type: "synth",
        replacement: synthReplacement(call.name, originalText, state.consecutiveRepeats),
        trippedTool: call.name,
        consecutiveRepeats: state.consecutiveRepeats,
      };
    }

    return { type: "pass" };
  }

  return {
    observe,
    snapshot: () => ({
      trippedTools: [...states.entries()].filter(([, s]) => s.tripped).map(([name]) => name),
      callCounts: Object.fromEntries(
        [...states.entries()].map(([name, s]) => [name, s.totalCalls]),
      ),
    }),
  };
}
