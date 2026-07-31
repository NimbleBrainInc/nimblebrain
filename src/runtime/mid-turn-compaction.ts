import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { planCompaction } from "../conversation/compaction.ts";
import type { StoredMessage } from "../conversation/types.ts";
import type { EngineHooks } from "../engine/types.ts";

/**
 * Mid-turn history compaction — the turn-setup compaction check, re-applied
 * between the agent loop's iterations.
 *
 * ## Why
 *
 * Turn setup compacts once, before the engine runs. The loop then appends an
 * assistant message plus its tool results on every iteration, so a turn that
 * tool-calls its way through many iterations can outgrow the very budget it was
 * checked against — a turn that starts comfortably under the threshold can end
 * far over it, and neither the compaction trigger nor the configured input cap
 * is consulted again. Per-call latency and spend scale with that growth.
 *
 * ## Shape
 *
 * This is policy, not mechanism: it decides WHEN a mid-turn fold is warranted
 * and hands the actual fold to `compact` — the same runtime path turn setup
 * uses, so a mid-turn compaction persists the same `history.compacted` event,
 * retains operator turns from the same event log, and plans against the same
 * threshold. The engine reaches it through `EngineHooks.rewriteHistory` and
 * stays unaware that compaction exists.
 *
 * Two properties keep it from thrashing:
 *
 * - **A fold leaves the history at ~`keepRatio` of budget**, well under the
 *   ~`triggerRatio` that fires one, so re-firing takes real growth — re-checking
 *   every iteration is not re-compacting every iteration. Each fold costs one
 *   prompt-cache re-anchor, the same trade turn-setup compaction makes.
 * - **A fold that comes back empty stops the loop from asking again.** The plan
 *   here and the plan inside `compact` run the same function over the same
 *   messages, so they agree; an empty result means the fold itself failed
 *   (compaction is best-effort — a summarizer error falls back to the full
 *   history), and retrying it every iteration would spend a summarizer call per
 *   iteration to fail the same way.
 *
 * One fidelity difference from turn setup, which folds the un-rehydrated
 * history: an in-flight history has been rehydrated, so an attachment reaches
 * the summarizer as a file part and renders `[file]` instead of the
 * `[file: name]` a resource link renders. The summary loses the attachment's
 * name; the bytes were never in the transcript either way.
 */

export interface MidTurnCompactionDeps {
  /** The per-call message budget this turn was composed against. */
  budget: number;
  /**
   * Timestamps of the turn's opening history, index-aligned with the messages
   * handed to the engine. The engine's messages have none of their own —
   * rehydration strips the platform extras — but compaction is ts-keyed: the
   * boundary it persists, and the operator turns it retains, are both
   * timestamps. Messages the loop appends have no timestamp and need none: the
   * boundary always snaps back to a user turn, and only the opening history
   * holds those.
   */
  initialTimestamps: readonly (string | undefined)[];
  /**
   * Fold an over-budget history, returning the compacted messages or `null`
   * when nothing changed. This is `Runtime.maybeCompactHistory` bound to the
   * turn's conversation and budget.
   */
  compact: (history: StoredMessage[]) => Promise<StoredMessage[] | null>;
}

/** Strip the platform extras so the shape is exactly what the engine sends. */
function toModelMessage(message: StoredMessage): LanguageModelV3Message {
  const { role, content, providerOptions } = message;
  return (
    providerOptions ? { role, content, providerOptions } : { role, content }
  ) as LanguageModelV3Message;
}

export function buildMidTurnCompaction(
  deps: MidTurnCompactionDeps,
): NonNullable<EngineHooks["rewriteHistory"]> {
  // Rebased on every fold from the compacted array itself, so the alignment
  // survives a turn that compacts more than once.
  let timestamps: readonly (string | undefined)[] = deps.initialTimestamps;
  let stopped = false;

  return async (messages) => {
    if (stopped) return null;

    const stored = messages.map((message, i) => {
      const ts = timestamps[i];
      return (ts ? { ...message, timestamp: ts } : message) as StoredMessage;
    });

    const plan = planCompaction(stored, { budget: deps.budget });
    if (!plan.shouldCompact) return null;
    // A boundary with no timestamp would persist as a `compactedThroughTs` that
    // every event sorts at or after, replaying as the summary PLUS the whole
    // history. Unreachable while the boundary snaps to a user turn, and cheap
    // to make structurally impossible.
    if (!plan.boundaryTs) {
      stopped = true;
      return null;
    }

    const compacted = await deps.compact(stored);
    if (!compacted) {
      stopped = true;
      return null;
    }

    timestamps = compacted.map((message) => message.timestamp);
    return compacted.map(toModelMessage);
  };
}
