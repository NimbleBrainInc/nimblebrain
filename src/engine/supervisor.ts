import { createHash } from "node:crypto";
import { extractTextForModel, textContent } from "./content-helpers.ts";
import {
  INFRA_ERROR_META_KEY,
  NON_ADVANCING_META_KEY,
  type ToolCall,
  type ToolResult,
} from "./types.ts";

/**
 * Per-run loop supervisor.
 *
 * Watches the per-call fingerprint of every tool result inside an engine
 * run. If a single tool returns the same fingerprint N times in a row,
 * the supervisor declares that tool stuck and replaces its next result
 * with a synthetic directive instructing the model to stop calling the
 * tool and produce a final response.
 *
 * Three failure modes this catches:
 *  - Upstream returns identical 4xx errors on every call (e.g. a tool
 *    whose schema-derived args trigger a deterministic server-side
 *    rejection). The model often retries with cosmetic argument tweaks
 *    and gets the same rejection each time.
 *  - Upstream returns identical "empty success" payloads to the same
 *    call (pagination dead-ends; idempotent lookups against an
 *    unchanged state).
 *  - A tool reports it made no progress (a discovery search matching
 *    nothing) while the model keeps varying the query — so input AND
 *    content differ every call, defeating the two fingerprints below.
 *
 * Fingerprint composition (three shapes of "stuck"):
 *
 *  - NON-ADVANCING: (toolName, NONADVANCING). When `result._meta` carries
 *    `NON_ADVANCING_META_KEY`, the fingerprint ignores input and content,
 *    so a tool that keeps reporting no progress trips at N regardless of how
 *    the model varied the call. Catches the flailing-discovery loop the
 *    input-aware SUCCESS path deliberately lets through.
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
 * RECOVERY — a trip is a verdict on the evidence so far, not a life
 * sentence. A tripped tool that returns an ADVANCING SUCCESS (not an
 * error, not infra-flagged, not `_meta`-flagged non-advancing) whose
 * CONTENT differs from the content it tripped on has falsified the
 * premise: it demonstrably works. The trip clears and the real result
 * flows through untouched.
 *
 * This matters because the trip evidence is often about the CALLER, not
 * the tool. The ERROR fingerprint ignores input by design, so N calls
 * that fail the same schema validation collapse to one fingerprint and
 * trip — even though each carried different (differently wrong)
 * arguments. When the model then fixes its arguments and the call
 * succeeds, holding the trip would report a landed write as a failure
 * and send the model looking for a workaround. Suppressing a real
 * result is worse than a late trip: it makes the model act on a false
 * picture of what the world now contains.
 *
 * Recovery compares CONTENT, not the fingerprint, and the difference is
 * load-bearing. The SUCCESS fingerprint folds in the canonicalized
 * input, so a fingerprint comparison would let the empty-success mode
 * walk straight out of its own trip: `page(cursor=1)` trips on three
 * identical empty pages, then `page(cursor=2)` returns that same empty
 * page under a different input, and a fingerprint check calls it
 * progress. The dead-end loop then resumes with the guard disarmed and
 * never re-trips, because every subsequent cursor is a fresh
 * fingerprint too. Content is what "the tool is still stuck" means
 * without reference to how the call was phrased.
 *
 * The cost is that a tool whose results carry no model-facing text —
 * `structuredContent` only, or content annotated for the user audience —
 * hashes to the empty string on every call, so once tripped it cannot
 * recover. That fails closed and matches the behavior before recovery
 * existed. Folding `structuredContent` in would fix it and reopen the
 * hole above, since one timestamp field would make every call look like
 * progress; a text-free tool wanting recovery should emit a varying
 * field the model can see.
 *
 * The supervisor itself never aborts the run; the engine reads the
 * verdict and decides what to surface. While a tool is tripped the
 * engine drops it from `modelTools`, rebuilding that set from
 * `snapshot()` every iteration — so a recovery restores it on the next
 * turn with no further coordination. Note the drop makes the tool
 * UNADVERTISED, not unreachable: dispatch reads `toolSchemaMap` only to
 * validate input, and a miss skips validation and still executes. A
 * model that names a dropped tool anyway therefore still runs it, which
 * is the path by which a tripped tool can reach this code at all. The
 * directive below deliberately does not advertise that path.
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
  /** Content hash of the result that tripped this tool. A later success must
   *  differ from THIS to count as progress — see RECOVERY in the file header.
   *  Null whenever `tripped` is false. */
  trippedContent: string | null;
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

/**
 * Whether a result is evidence that the tool is doing real work: a plain
 * success, with neither of the two `_meta` flags that mean "this tells you
 * nothing about the tool" (an infrastructure failure that never reached the
 * tool's logic) or "this made no progress" (the tool's own admission).
 *
 * Only this shape can clear a trip. Content is not inspected — a tool that
 * returns success is taken at its word, exactly as the SUCCESS fingerprint does.
 */
function isAdvancingSuccess(result: ToolResult): boolean {
  if (result.isError) return false;
  if (result._meta?.[INFRA_ERROR_META_KEY] === true) return false;
  if (result._meta?.[NON_ADVANCING_META_KEY] === true) return false;
  return true;
}

export function createRunSupervisor(config: SupervisorConfig = {}): RunSupervisor {
  const maxRepeats = config.maxConsecutiveRepeats ?? DEFAULT_MAX_REPEATS;
  const textCap = config.fingerprintTextCap ?? DEFAULT_FINGERPRINT_CAP;

  const states = new Map<string, ToolState>();

  function getState(toolName: string): ToolState {
    let s = states.get(toolName);
    if (!s) {
      s = {
        lastFingerprint: null,
        consecutiveRepeats: 0,
        totalCalls: 0,
        tripped: false,
        trippedContent: null,
      };
      states.set(toolName, s);
    }
    return s;
  }

  /** Hash of just the result text the model would see, capped like the
   *  fingerprint's. Input-free on purpose: this is what "the tool returned the
   *  same thing again" means independently of how the call was phrased. */
  function contentHash(result: ToolResult): string {
    return createHash("sha1")
      .update(extractTextForModel(result.content).trim().slice(0, textCap))
      .digest("hex");
  }

  function fingerprint(call: ToolCall, result: ToolResult): string {
    // A result a tool explicitly flags as non-advancing (a search that
    // matched nothing, a lookup against unchanged state) collapses to ONE
    // canonical fingerprint per tool — input- AND content-agnostic. This is
    // the counterpart to the input-aware success path below: that path treats
    // a varied input as progress and never trips, which is right for a tool
    // doing real work but wrong for a discovery loop where the model varies
    // the query every call and keeps hitting the same dead end. Flagged
    // results trip after `maxRepeats` no matter how input/content varied.
    //
    // The flag is a single explicit opt-in boolean read by key from `_meta`
    // (the MCP-blessed metadata channel that survives the tool boundary) —
    // NOT a fold of the whole result into the hash, which would regress the
    // guard the way the SUCCESS comment below warns against.
    if (result._meta?.[NON_ADVANCING_META_KEY] === true) {
      return createHash("sha1").update(`${call.name}\0NONADVANCING`).digest("hex");
    }
    // Known limitation: hashing only the first `textCap` chars can
    // false-positive on tools that return a long stable preamble (e.g. a
    // verbose header) followed by a short varying field. Two semantically
    // distinct results may collapse to the same fingerprint and trip the
    // supervisor early. If that bites, hash head+tail rather than head-only.
    //
    // Deliberately NOT addressed by folding `structuredContent` into the hash.
    // Tempting (a mutating tool's varying data often lives there), but it
    // regresses this guard's core job: a paginated tool with an advancing
    // cursor, or any tool that stamps a timestamp / request-id into its
    // structured payload, would then produce a unique fingerprint on every
    // call and never trip — even in a genuine loop. The contract is the
    // inverse: a mutating tool must emit a per-call-varying field that reaches
    // `content`. FastMCP serializes a structured return into both `content`
    // and `structuredContent`, so a field like synapse-collateral's
    // WorkspaceState.source_sha (a hash of the edited document) satisfies it.
    // Fix a falsely-tripping tool at the tool, not by weakening the guard.
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
    //
    // It also does NOT mention that a corrected call can clear the trip, even
    // though one can. The tool has just been dropped from the model's toolset,
    // so an invitation to retry is an invitation to go hunting for a way to
    // call something it can no longer see — which is the exact loop this guard
    // exists to end, and which cost a real run half its budget. Recovery is a
    // property of the mechanism, not advice to the model.
    const directive =
      // "made no progress" rather than "returned the same result": accurate
      // across all three trip modes — identical errors, identical empty
      // success, AND the non-advancing case where the results vary textually
      // (different "no match" strings) but represent the same dead end.
      `[NB supervisor] Tool \`${toolName}\` made no progress ${repeats} times in a row ` +
      `and has been disabled.\n\n` +
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
      // A tripped tool that ADVANCES has disproved the trip — clear it and let
      // the real result through (see RECOVERY in the file header). The bar is
      // deliberately narrow: an error, an infrastructure failure, or a result
      // the tool itself flagged non-advancing is not evidence the tool works,
      // and neither is returning the very content it tripped on.
      //
      // Checked BEFORE the infrastructure skip below, and that skip still
      // cannot quietly re-enable a tool: `isAdvancingSuccess` rejects an
      // infra-flagged result on the flag itself, not merely on `isError`, so
      // the guarantee does not rest on transport failures happening to be
      // marked as errors.
      if (isAdvancingSuccess(result) && contentHash(result) !== state.trippedContent) {
        state.tripped = false;
        state.trippedContent = null;
        state.consecutiveRepeats = 1;
        state.lastFingerprint = fingerprint(call, result);
        return { type: "pass" };
      }
      // Still stuck: every subsequent call keeps getting the synthetic
      // directive. The engine drops tripped tools from modelTools, so the model
      // is no longer offered this one — but dispatch does not check that list,
      // so a model that names it anyway still reaches here.
      const originalText = extractTextForModel(result.content).trim();
      return {
        type: "synth",
        replacement: synthReplacement(call.name, originalText, state.consecutiveRepeats),
        trippedTool: call.name,
        consecutiveRepeats: state.consecutiveRepeats,
      };
    }

    // An infrastructure failure is not evidence about the tool. The guard's
    // premise is that a repeated identical error means the tool is
    // deterministically refusing the work — true for a schema rejection, false
    // for a throttle or a dropped transport, where the call never reached the
    // tool's logic at all. Counting these disables the tool precisely when
    // retrying is the correct response, and it trips fast: the ERROR fingerprint
    // ignores input, so a batch of calls with distinct arguments that all fail
    // the same infrastructural way collapses to one fingerprint.
    //
    // Deliberately does NOT reset `consecutiveRepeats`. A genuine loop
    // interrupted by a transient blip is still a loop, and letting an
    // infrastructure error clear the counter would hand a flailing tool an easy
    // way to never trip. The observation is skipped, not treated as progress.
    if (result._meta?.[INFRA_ERROR_META_KEY] === true) {
      return { type: "pass" };
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
      state.trippedContent = contentHash(result);
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
