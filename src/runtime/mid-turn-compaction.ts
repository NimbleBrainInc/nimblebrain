import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { COMPACTION_DEFAULTS, compactionSummaryMessages } from "../conversation/compaction.ts";
import { groupMessages } from "../conversation/window.ts";
import { estimateMessageTokens } from "../engine/token-estimate.ts";
import type { EngineHooks } from "../engine/types.ts";

/**
 * Mid-turn history compaction — folding the history a single turn grows.
 *
 * ## Why
 *
 * Turn setup compacts once, before the engine runs. The loop then appends an
 * assistant message plus its tool results on every iteration, so a turn that
 * tool-calls its way through many iterations outgrows the very budget it was
 * checked against, and nothing checks again. Per-call latency and spend scale
 * with that growth for the rest of the turn.
 *
 * ## Why this is not `planCompaction`
 *
 * Between turns, a fold is persisted, and the event that persists it names its
 * boundary by timestamp — so the boundary must be a timestamped message that
 * starts a whole turn, which in practice means a user turn.
 *
 * Inside a turn, neither half of that holds. The region that grows is
 * assistant/tool messages the loop appended, which carry no timestamps (they
 * are not stored messages) and contain no user turn to snap to. A planner that
 * insists on a user boundary can therefore only ever cut in front of the
 * growth, never into it: it folds the opening history once and then reports
 * "nothing to compact" for every remaining iteration while the turn keeps
 * growing.
 *
 * So a mid-turn fold answers a different question and obeys a different
 * constraint. It cuts on a GROUP boundary — `groupMessages` computes the atomic
 * units, a tool-calling assistant message plus its results — because the only
 * thing the model requires is that a tool call keep its results. That boundary
 * needs no timestamp, which is exactly why it can cut where the growth is.
 *
 * The consequence is that a mid-turn fold is **in-memory, for this turn only**:
 * having no timestamp, it cannot be written as a `history.compacted` event. The
 * conversation's record is untouched — the next turn reads the full history from
 * the append-only log and turn setup folds it the persistent, operator-retaining
 * way. What this bounds is what gets SENT, which is what costs money and time.
 *
 * ## Not thrashing
 *
 * A fold leaves the history at ~`keepRatio` of budget and the next one fires at
 * ~`triggerRatio`, so the rate is bounded by the headroom between them: **at
 * most one fold per `triggerRatio - keepRatio` (0.35) of a budget's worth of
 * appended content**, however often the policy is asked. Re-checking every
 * iteration is not re-folding every iteration. Each fold costs one summarizer
 * call and one prompt-cache re-anchor, the same trade turn-setup compaction
 * makes.
 *
 * A fold that fails takes the policy out for the rest of the turn: compaction is
 * best-effort, the threshold stays crossed, and retrying would spend one
 * summarizer call per remaining iteration to fail the same way.
 *
 * Sizing uses the part-aware `estimateMessageTokens`, not chars-over-JSON: an
 * in-flight history is rehydrated, so an attachment is a file part holding raw
 * bytes, and `JSON.stringify` of those bytes reads as ~700× the tokens they
 * actually cost. Estimating the prompt about to be sent is also the question
 * this policy is asking.
 */

export interface MidTurnCompactionDeps {
  /** The per-call message budget this turn was composed against. */
  budget: number;
  /**
   * Summarize the folded-away messages. Throws on failure — the caller treats a
   * throw as "skip the fold", never as a failed turn.
   */
  summarize: (messages: LanguageModelV3Message[], signal?: AbortSignal) => Promise<string>;
}

/**
 * Where to cut: the start of the oldest group that still fits inside the kept
 * tail, or `null` when the history is under the trigger or has too little in
 * front of the cut to be worth a summarizer call. Pure.
 */
export function planMidTurnFold(
  messages: readonly LanguageModelV3Message[],
  budget: number,
): number | null {
  const total = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (total <= COMPACTION_DEFAULTS.triggerRatio * budget) return null;

  const keepTarget = COMPACTION_DEFAULTS.keepRatio * budget;
  const groups = groupMessages([...messages]);
  let kept = 0;
  let cut = messages.length;
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!;
    kept += group.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    cut -= group.length;
    if (kept >= keepTarget) break;
  }

  // A tool result whose call was folded away is rejected by the provider, so
  // the tail never opens on one. Grouping already pairs them; this holds for a
  // stray result the grouper had no call to attach.
  while (cut < messages.length && messages[cut]!.role === "tool") cut++;

  return cut < COMPACTION_DEFAULTS.minSummarizedMessages ? null : cut;
}

/**
 * The folded history: the summary seed, then the kept tail. The seed's
 * acknowledgement exists to keep user→assistant alternation, so it is emitted
 * only when the tail opens on a user message; a tail opening on an assistant
 * message already alternates against the summary turn.
 */
function foldedHistory(summary: string, tail: LanguageModelV3Message[]): LanguageModelV3Message[] {
  // Empty timestamp, and the extras are stripped below: this seed lives for the
  // rest of the turn and is never stored, so it has no timestamp to carry.
  const seed = compactionSummaryMessages(summary, "");
  const head = tail[0]?.role === "user" ? seed : seed.slice(0, 1);
  return [
    ...head.map(({ role, content }) => ({ role, content }) as LanguageModelV3Message),
    ...tail,
  ];
}

export function buildMidTurnCompaction(
  deps: MidTurnCompactionDeps,
): NonNullable<EngineHooks["rewriteHistory"]> {
  let stopped = false;

  return async (messages, { signal }) => {
    if (stopped) return null;

    const cut = planMidTurnFold(messages, deps.budget);
    if (cut === null) return null;

    try {
      const summary = await deps.summarize(messages.slice(0, cut), signal);
      return foldedHistory(summary, messages.slice(cut));
    } catch {
      // Best-effort, exactly as between turns: keep the full history and stop
      // asking. The caller logs the failure at the summarizer call site.
      stopped = true;
      return null;
    }
  };
}
