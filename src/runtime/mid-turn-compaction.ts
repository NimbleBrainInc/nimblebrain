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
 * assistant message plus its tool results on every iteration, and nothing folds
 * again — so a turn that tool-calls its way through many iterations ends far
 * over the budget it was checked against.
 *
 * What that costs is not an unbounded prompt. `transformContext` re-windows
 * every iteration against the same budget (`buildTransformContext` →
 * `windowMessages`), so the request stays bounded. It stays bounded by DROPPING
 * middle groups: once the history is over budget the turn runs pinned at its
 * cap, re-deciding every iteration what to leave out, and what it leaves out is
 * gone with no trace the model can see.
 *
 * Folding takes that decision away from windowing. Measured on the loop in
 * `test/unit/mid-turn-compaction.test.ts`: windowing alone drops a group on six
 * of nine calls, and with the fold it drops on none — the span that leaves the
 * context leaves once, as a summary, instead of being re-decided every
 * iteration and leaving no trace. Peak per-call input falls with it (3,975 →
 * 3,593 against a 4,000 budget), but the size is the smaller half; a request
 * pinned at its cap is bounded, it is just bounded by forgetting.
 *
 * It is the same trade `conversation/compaction.ts` makes between turns — a
 * deliberate, infrequent re-anchor instead of per-call windowing — applied
 * within one, and priced for one (see `MID_TURN_TRIGGER_RATIO`).
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
 * "nothing to compact" for every remaining iteration.
 *
 * So a mid-turn fold obeys the constraint that does apply inside a turn. It
 * cuts on a GROUP boundary — `groupMessages` computes the atomic units, a
 * tool-calling assistant message plus its results — because the only thing the
 * model requires is that a tool call keep its results. That boundary needs no
 * timestamp, which is exactly why it can cut where the growth is.
 *
 * The consequence is that a mid-turn fold is **in-memory, for this turn only**:
 * having no timestamp, it cannot be written as a `history.compacted` event. The
 * conversation's record is untouched — the next turn reads the full history from
 * the append-only log and turn setup folds it the persistent way.
 *
 * ## Not thrashing
 *
 * A fold leaves the history at ~`keepRatio` of budget and the next one fires at
 * the budget, so the rate is bounded by the headroom between them: at most one
 * fold per 0.65 of a budget's worth of appended content. Re-checking every
 * iteration is not re-folding every iteration.
 *
 * Two things end the asking rather than rely on that headroom, because both can
 * exhaust it. A fold that FAILS stops the policy for the turn: compaction is
 * best-effort, the threshold stays crossed, and retrying spends a summarizer
 * call per remaining iteration to fail the same way. A fold that lands still
 * over the trigger stops it too — the summary's size is the summarizer's to
 * choose, and on a small budget a maximal one can exceed the whole headroom, so
 * folding again would buy nothing at the price of a summarizer call and a cache
 * re-anchor each iteration. In both cases windowing bounds the request from
 * there, exactly as it did before this existed.
 *
 * ## Fidelity, against the fold between turns
 *
 * Two things that fold does are not done here, both because this fold is
 * temporary and the record it would protect is not at risk:
 *
 * - Operator turns are not retained verbatim (`selectRetainedOperatorMessages`).
 *   Retention exists to stop corrections decaying through summary-of-summary
 *   over a conversation's life; this summary is discarded at the end of the
 *   turn. Within the turn, an operator turn ahead of the cut survives as summary
 *   prose — which is still more than windowing left of it.
 * - An attachment reaches the summarizer as a rehydrated file part and renders
 *   `[file]`, where a resource link renders `[file: name]`. The summary loses
 *   the attachment's name; the bytes were never in the transcript either way.
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
 * Fold when the history reaches the budget — not before.
 *
 * `windowMessages` returns its input untouched at or below the budget
 * (`conversation/window.ts`), and this hook runs before it in the same
 * iteration, so a trigger of exactly 1.0 means windowing never drops a group:
 * the fold takes over precisely where dropping would otherwise start, and not a
 * token earlier. Below the budget the request is append-only and reads back
 * from cache, so folding there would buy a smaller prompt at the price of a
 * summarizer call and a full re-write of the prefix — a trade that needs more
 * iterations to repay than a turn which never reaches its budget has left.
 *
 * The 0.7 `conversation/compaction.ts` triggers on is a different economy: that
 * fold is persisted, so its one re-anchor amortizes over every later turn. This
 * one is discarded at the end of the turn and has to pay for itself inside it.
 */
const MID_TURN_TRIGGER_RATIO = 1;

/** The prompt-sized estimate: what these messages will cost when sent. */
function estimateTokens(messages: readonly LanguageModelV3Message[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
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
  if (estimateTokens(messages) <= MID_TURN_TRIGGER_RATIO * budget) return null;

  const keepTarget = COMPACTION_DEFAULTS.keepRatio * budget;
  const groups = groupMessages([...messages]);
  let kept = 0;
  let cut = messages.length;
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!;
    kept += estimateTokens(group);
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
      const folded = foldedHistory(summary, messages.slice(cut));
      // A fold can land back over the line it just crossed, from either side of
      // what it produces: the summary is sized by the summarizer, not by
      // `keepTarget`, and the retained tail can exceed the budget on its own
      // when a single tool-result group does. Keep the shrink, stop asking —
      // folding again would spend a summarizer call and a cache re-anchor per
      // iteration to stay over the line. Windowing bounds it from there.
      if (estimateTokens(folded) > MID_TURN_TRIGGER_RATIO * deps.budget) stopped = true;
      return folded;
    } catch {
      // Best-effort, exactly as between turns: keep the full history and stop
      // asking. The caller logs the failure at the summarizer call site.
      stopped = true;
      return null;
    }
  };
}
