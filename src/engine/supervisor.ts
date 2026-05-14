import { createHash } from "node:crypto";
import { extractTextForModel, textContent } from "./content-helpers.ts";
import type { ToolCall, ToolResult } from "./types.ts";

/**
 * Per-run loop supervisor.
 *
 * Watches the (toolName, isError, content) fingerprint of every tool result
 * inside an engine run. If a single tool returns the same fingerprint N
 * times in a row, the supervisor declares that tool stuck and replaces its
 * next result with a synthetic directive instructing the model to stop
 * calling the tool and produce a final response.
 *
 * Two failure modes this catches:
 *  - Upstream returns identical 4xx errors on every call (e.g. a tool whose
 *    schema-derived args trigger a deterministic server-side rejection).
 *  - Upstream returns identical "empty success" payloads (pagination dead-ends).
 *
 * Per-tool isolation: a stuck tool doesn't trip the supervisor on unrelated
 * tools. Reset-on-different-fingerprint preserves legitimate adaptive retry
 * behaviour (a tool that fails once with error A, then once with error B,
 * then succeeds, never trips).
 *
 * Pairs with a one-shot system-prompt nudge consumed by the engine on the
 * iteration after a trip — see `needsPromptNudge` / `consumeNudge`. The
 * supervisor itself never aborts the run; the engine reads the verdict and
 * decides what to surface.
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
  /**
   * True when a synth verdict was issued since the last `consumeNudge` —
   * the engine should append a single-shot system-prompt nudge to the
   * next iteration.
   */
  needsPromptNudge(): boolean;
  /** Clear the nudge flag after the engine emits the nudge. */
  consumeNudge(): void;
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

export function createRunSupervisor(config: SupervisorConfig = {}): RunSupervisor {
  const maxRepeats = config.maxConsecutiveRepeats ?? DEFAULT_MAX_REPEATS;
  const textCap = config.fingerprintTextCap ?? DEFAULT_FINGERPRINT_CAP;

  const states = new Map<string, ToolState>();
  let pendingNudge = false;

  function getState(toolName: string): ToolState {
    let s = states.get(toolName);
    if (!s) {
      s = { lastFingerprint: null, consecutiveRepeats: 0, totalCalls: 0, tripped: false };
      states.set(toolName, s);
    }
    return s;
  }

  function fingerprint(call: ToolCall, result: ToolResult): string {
    const text = extractTextForModel(result.content).trim().slice(0, textCap);
    return createHash("sha1")
      .update(`${call.name}\0${result.isError ? "E" : "S"}\0${text}`)
      .digest("hex");
  }

  function synthReplacement(toolName: string, originalText: string, repeats: number): ToolResult {
    const directive =
      `[NB supervisor] Tool \`${toolName}\` has returned the same result ${repeats} times in a row. ` +
      `This is a loop. Stop calling this tool.\n\n` +
      `Underlying tool output (last call):\n${originalText}\n\n` +
      `Required action: produce a final response to the user that includes:\n` +
      `1. What you were trying to accomplish.\n` +
      `2. The literal error or output above so the user can act on it.\n` +
      `3. One concrete suggestion (check the connection, narrow the question, try a different tool, etc.).\n\n` +
      `Do not call any tools. End the run.`;
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
      // the synthetic directive. The model receives an unambiguous "this
      // tool is unusable" signal regardless of whether the upstream call
      // would now succeed — recovering from a stuck loop happens in a new
      // run, not mid-run.
      const originalText = extractTextForModel(result.content).trim();
      pendingNudge = true;
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
      pendingNudge = true;
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
    needsPromptNudge: () => pendingNudge,
    consumeNudge: () => {
      pendingNudge = false;
    },
    snapshot: () => ({
      trippedTools: [...states.entries()].filter(([, s]) => s.tripped).map(([name]) => name),
      callCounts: Object.fromEntries(
        [...states.entries()].map(([name, s]) => [name, s.totalCalls]),
      ),
    }),
  };
}
