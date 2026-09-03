/**
 * Canonical token-usage shape — used by engine, runtime, conversation
 * events, storage, and cost computation.
 *
 * Provider-aligned with AI SDK V3 (LanguageModelV3Usage):
 *   inputTokens  = grand total of input-side tokens
 *                = noCache + cacheRead + cacheWrite
 *   outputTokens = grand total of output-side tokens
 *                = text + reasoning
 *   cacheReadTokens, cacheWriteTokens, reasoningTokens are SUBSETS of
 *   the totals above. Cost computation must subtract them from the totals
 *   before applying the full input/output rates.
 *
 * One shape, one definition. Anything that touches token counts uses this
 * type — there is intentionally no "partial" or "flat" alternative. The
 * compiler enforces that callers supply the full struct, which is what
 * keeps cost computation from silently dropping a field.
 */
import type { LanguageModelV3Usage } from "@ai-sdk/provider";

/**
 * Who a priced LLM call was made on behalf of, as distinct from *which slot*
 * made it (`LlmUsageSource` — main / title / compaction / briefing).
 *
 * Derived from the request context, never asserted by a caller: `task` when the
 * context is unattended, `chat` when it carries a conversation, `system` for a
 * call with no request scope at all (a detached fast-slot call or a background
 * job). Lives here rather than beside the counters so `api/metrics.ts` can name
 * the label type without importing the module that derives it.
 *
 */
export type LlmCallOrigin = "chat" | "task" | "system";

/**
 * Unit prices in USD per 1M tokens, resolved at write time and stored on the
 * ledger line.
 *
 * Not an accounting feature — this ledger is a display surface, not a system of
 * record. It is stored for durability across the retention window: cost is
 * otherwise computed from the live catalog at read time, and over 24 months
 * that means a price change silently restates a number already shown, while a
 * model dropped from the catalog takes its own history to `$0.00`, since
 * `costBreakdown` returns all-zeros for a model it cannot find.
 *
 * `cacheWrite5m` / `cacheWrite1h` are the two TTL tiers billed at different
 * multiples of base input; see `cost.ts`. Absent on a line whose model the
 * catalog did not know at write time, which the reader treats as unpriced —
 * distinct from priced at zero.
 */
export interface UsageRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning?: number;
}

/**
 * One priced LLM call, as written to the durable usage ledger.
 *
 * Usage used to be derived from a storage side effect — a conversation JSONL
 * happening to exist, in a workspace still on disk — so any call path that did
 * not write one was invisible by default, and four such paths existed. A line
 * here is a *fact recorded at the point of spend*, which is what makes the next
 * non-conversation call path visible without anyone remembering to wire it.
 *
 * Written only by `src/usage/record.ts`; read only by `src/usage/aggregate.ts`.
 */
export interface UsageLedgerEntry {
  /** ISO-8601, the call's completion time. */
  ts: string;
  /** Which slot made the call: main loop, or a forked fast slot. */
  source: string;
  /** Who the call was for, derived from the request scope. */
  origin: LlmCallOrigin;
  /** Qualified, e.g. `nebius:zai-org/GLM-5.1`. The prefix is the provider. */
  model: string;
  usage: TokenUsage;
  llmMs: number;
  /** `identity.id` from the request context. */
  userId?: string;
  /** The one workspace the call was bound to. */
  workspaceId?: string;
  /**
   * The chat thread this call belongs to. Absent for a task run (which has no
   * conversation) and for a detached background call.
   */
  conversationId?: string;
  /**
   * The engine run this call belongs to — one `run.start`→`run.done` span,
   * which is one assistant turn. Present for chat and task alike; absent on
   * the forked fast-slot calls (title, compaction, briefing), which emit no
   * event and are not a turn of their own.
   */
  runId?: string;
  /**
   * The automation run this call belongs to (`executeTask`'s correlation id).
   * Absent in chat. Distinct from {@link runId}: this is the id the automations
   * bundle persists the run result under, so it is the join key from spend back
   * to a stored run.
   */
  taskRunId?: string;
  /**
   * @deprecated Legacy read-only. Held whichever id correlated the work — a
   * conversation for chat, an automation run for a task — discriminated by
   * `origin`. No longer written; `conversationId` / `taskRunId` carry those
   * two facts under their own names, and `runId` adds the per-turn grain the
   * single field could not express.
   *
   * Readers must keep honouring it until every retained record predating the
   * split has aged out (see `retentionMonths`, default 24). `aggregate.ts`
   * normalizes it; nothing else should read it.
   */
  sessionId?: string;
  /**
   * @deprecated Legacy read-only. Set on records written while the runtime
   * could spawn a sub-agent from inside a turn: `delegated` marked such a
   * call and `parentRunId` named the top-level run it belonged to. Neither is
   * written any more — a run starts one way, and its calls carry `runId`.
   *
   * `aggregate.ts` still reads `parentRunId` so a retained record from that
   * era rolls onto the turn that spawned it (see `retentionMonths`, default
   * 24). Nothing else should read either field.
   */
  delegated?: boolean;
  /** @deprecated Legacy read-only. See {@link delegated}. */
  parentRunId?: string;
  /** Resolved unit prices. Absent when the catalog did not know the model. */
  rates?: UsageRates;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * The portion of `cacheWriteTokens` written with a 1-HOUR TTL (billed at 2x
   * base input vs 1.25x for the 5-minute remainder). The engine tiers TTL by
   * breakpoint stability (1h on system+tools, 5m on the rolling history), so
   * this distinguishes the two for accurate costing. Subset of
   * `cacheWriteTokens`; the rest is the 5-minute portion. Absent on legacy
   * events (pre-tiering, when all writes were 1h) — cost treats absent as
   * all-1h so historical figures stay correct.
   */
  cacheWrite1hTokens?: number;
}

/**
 * Map an AI SDK V3 `doGenerate`/`doStream` usage struct into the canonical
 * `TokenUsage`.
 *
 * Deliberately omits `cacheWrite1hTokens` — that 1h/5m split comes from
 * provider metadata the engine reads separately, not from this usage struct.
 * Cost treats an absent split as all-1h (the 2x rate; see `cost.ts`), so a
 * caller that sets `cache_control` breakpoints AND maps usage only through here
 * would over-cost its cache writes. Safe for the current callers (the forked
 * `fast`-slot utility calls — compaction summarizer, auto-title, briefing —
 * issue raw `doGenerate` with no breakpoints, so `cacheWriteTokens` is ~0); the
 * engine layers the 1h split on top of this for the main loop.
 */
export function tokenUsageFromV3(usage: LanguageModelV3Usage): TokenUsage {
  return {
    inputTokens: usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
    reasoningTokens: usage.outputTokens.reasoning ?? 0,
  };
}

/** Zero-valued TokenUsage. Convenience for accumulators. */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    // cacheWrite1hTokens is intentionally left undefined: it is tri-state, where
    // absent means "no TTL split reported" (cost treats that as all-1h). Forcing
    // it to 0 here would wrongly mark every accumulated write as 5-minute.
  };
}

/** Add `delta` into `target` in place. */
export function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0);
  // Preserve the tri-state: only materialize a number once some call actually
  // reported a 1h split, so "no split reported" stays absent (→ cost assumes 1h)
  // rather than collapsing to an explicit 0 (→ cost would assume all 5-minute).
  //
  // ASSUMES all deltas are same-era (same deploy): either all carry the split or
  // none do. That holds within a run (every event is same-deploy) and is the
  // only way addUsage is used today — the usage aggregator sums per-record
  // *costs* (each priced correctly by costBreakdown), never raw usage across the
  // boundary. Mixing a split-bearing delta with a legacy (no-split) one would
  // mis-bucket the legacy writes as 5-minute; that cross-deploy aggregation is
  // out of scope here (handled per-record at the cost boundary).
  if (target.cacheWrite1hTokens != null || delta.cacheWrite1hTokens != null) {
    target.cacheWrite1hTokens = (target.cacheWrite1hTokens ?? 0) + (delta.cacheWrite1hTokens ?? 0);
  }
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0);
}
