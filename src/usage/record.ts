/**
 * The single site that records one priced LLM call.
 *
 * Every call path that spends tokens goes through here. A new one that does not
 * is invisible to cost accounting by construction — which is the defect this
 * module exists to prevent, and which the runtime has already hit four times
 * (task runs, delegated sub-agents, background briefing refresh, and archived
 * workspaces all spent money no in-product surface showed).
 *
 * Two rules hold this together:
 *
 *  1. **Attribution is derived, never asserted.** `origin` and `delegated` come
 *     from the ambient request context and the emitting event, not from the
 *     caller. A caller that names its own origin is a caller that can be wrong
 *     about it, and the wrongness is silent — a mislabeled call still increments
 *     a counter, it just increments the wrong one.
 *  2. **`recordLlmUsage` is reachable only from here**, enforced by
 *     `scripts/check-usage-record.ts`. That is what makes rule 1 structural
 *     rather than a convention someone has to remember.
 *
 * Lives in `src/usage/` rather than beside the Prometheus counters because
 * "what a priced call is and who it was for" is a kernel accounting concern.
 * `api/metrics.ts` owns the wire format and stays a pure sink: it takes labels
 * and increments, and knows nothing about request scoping.
 */
import { type LlmUsageSource, recordLlmUsage } from "../api/metrics.ts";
import { getRequestContext } from "../runtime/request-context.ts";
import { resolveRates } from "./cost.ts";
import type { UsageLedger } from "./ledger.ts";
import type { LlmCallOrigin, TokenUsage, UsageLedgerEntry } from "./types.ts";

/**
 * The process's durable ledger, installed by the runtime at startup.
 *
 * Module-level rather than a parameter because the four call sites are spread
 * across the runtime, the adapters and the tools, and threading a handle to
 * each of them would put the ledger back in the callers' hands — the thing this
 * module exists to take away. Absent in unit tests and in any embedding that
 * never starts a runtime, where the Prometheus half still records.
 */
let ledger: UsageLedger | undefined;

/** Install the process ledger. Called by `Runtime.start`. */
export function setUsageLedger(next: UsageLedger | undefined): void {
  ledger = next;
}

/**
 * Release `owned`, if it is still the installed ledger.
 *
 * A shutting-down runtime has to let go of its ledger — nothing should append
 * into the work dir of a runtime that is gone. But the global holds one
 * ledger and a process may hold two runtimes, so an unconditional release is
 * how the earlier one silently disables the later one's writes: `recordLlmCall`
 * would fall through to the Prometheus half and leave no durable line, an
 * undercount of exactly the kind the ledger exists to remove. Ownership is the
 * whole check — release when nobody has taken over, never take it from whoever
 * has.
 */
export function clearUsageLedger(owned: UsageLedger): void {
  if (ledger === owned) ledger = undefined;
}

/**
 * Who this call was for, from the ambient request context alone.
 *
 * `unattended` is checked first and wins outright. A run carries `runId` and no
 * `conversationId`, so the conversation test alone would already answer
 * `system` rather than `chat` — but the flag is the direct question and does not
 * depend on which other fields a context happens to hold.
 *
 * `system` is the honest answer for a call with no request scope — a detached
 * fast-slot call, or a background job. It is not a fallback for "we could not
 * tell"; the three sources of scope are exhaustive.
 */
export function originOf(): LlmCallOrigin {
  const ctx = getRequestContext();
  if (ctx?.unattended) return "task";
  return ctx?.conversationId ? "chat" : "system";
}

/**
 * Whether this call belongs to a delegated sub-agent.
 *
 * Orthogonal to `originOf()` on purpose — a sub-agent spawned inside an
 * automation is both delegated and unattended. `ChildEventSink` stamps
 * `parentRunId` onto every event a child run emits, so presence is the signal.
 *
 * Empty-string-safe: `DelegateTracker.currentRunId` initializes to `""`, so a
 * truthiness check rather than a null check keeps a child that somehow ran
 * before any top-level `run.start` from being labeled with an empty parent.
 */
export function isDelegated(data: Record<string, unknown> | undefined): boolean {
  return typeof data?.parentRunId === "string" && data.parentRunId.length > 0;
}

/**
 * Record one priced LLM call.
 *
 * `event` is the emitting engine event's `data` payload, when there is one —
 * it supplies `parentRunId`. The forked fast-slot calls (title, compaction,
 * briefing) emit no event, so they omit it and are never delegated.
 *
 * Note that omitting the event says nothing about `origin`, which comes from
 * whatever scope the call runs in — not from its `source`. A turn's own forked
 * calls are wrapped in the turn's context by `chat()`, so a compaction summary
 * and an auto-title bill as `chat`, the conversation whose work they are doing.
 * A fast-slot call outside a turn is not: the background briefing refresh runs
 * its own context with no `conversationId` and correctly bills `system`.
 *
 * `test/integration/compaction-wiring.test.ts` and
 * `mid-turn-compaction-wiring.test.ts` drive real folds and assert this off
 * `/metrics`, so a turn's call escaping its scope fails a test rather than
 * quietly recording its spend as unattributed.
 *
 * Fans out to both halves of the chokepoint: the process-local Prometheus
 * counters, and the durable ledger that survives the process.
 */
export function recordLlmCall(args: {
  source: LlmUsageSource;
  model: string;
  usage: TokenUsage;
  llmMs?: number;
  event?: Record<string, unknown>;
}): void {
  const origin = originOf();
  const delegated = isDelegated(args.event);
  recordLlmUsage(args.source, args.model, args.usage, origin, delegated);
  if (!ledger) return;

  const ctx = getRequestContext();
  const parentRunId = args.event?.parentRunId;
  // Rates are resolved at write time so a past call keeps costing what it cost.
  // Absent when the catalog does not know the model, which the reader reports
  // as unpriced rather than as zero.
  const rates = resolveRates(args.model);
  const entry: UsageLedgerEntry = {
    ts: new Date().toISOString(),
    source: args.source,
    origin,
    delegated,
    model: args.model,
    usage: args.usage,
    llmMs: args.llmMs ?? 0,
    ...(delegated && typeof parentRunId === "string" ? { parentRunId } : {}),
    ...(ctx?.identity?.id ? { userId: ctx.identity.id } : {}),
    ...(ctx?.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    // Each id under its own name, so no reader has to consult `origin` to learn
    // what it is holding. `runId` is the engine's — the same referent as
    // `parentRunId` above, which is what lets the two compose into a
    // delegation tree — and it is the only one of the three that is per-TURN,
    // so it is what makes "what did this turn cost" answerable at all.
    //
    // `sessionId` is deliberately not written any more. It held a
    // conversation-or-run union discriminated by `origin`; the three fields
    // here say the same things without the discriminator, and say one more.
    // `aggregate.ts` still reads the old field for records already on disk.
    ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx?.runId ? { taskRunId: ctx.runId } : {}),
    ...(typeof args.event?.runId === "string" ? { runId: args.event.runId } : {}),
    ...(rates ? { rates } : {}),
  };
  ledger.append(entry);
}
