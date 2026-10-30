/**
 * The single site that records one priced LLM call.
 *
 * Every call path that spends tokens goes through here. A new one that does not
 * is invisible to cost accounting by construction — which is the defect this
 * module exists to prevent, and which the runtime has already hit four times
 * (task runs, sub-agent runs, background briefing refresh, and archived
 * workspaces all spent money no in-product surface showed).
 *
 * Two rules hold this together:
 *
 *  1. **Attribution is derived, never asserted.** `origin` comes from the
 *     ambient request context, not from the caller. A caller that names its own
 *     origin is a caller that can be wrong about it, and the wrongness is
 *     silent — a mislabeled call still increments a counter, it just increments
 *     the wrong one.
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
import { log } from "../observability/log.ts";
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
 * `system` is the honest answer for a call in a workspace with no conversation
 * and no task run — a background job. A call with no scope at all also reads
 * `system`, but only the counters see it: the ledger refuses it (see
 * `recordLlmCall`). It is not a fallback for "we could not tell"; the three
 * sources of scope are exhaustive.
 */
export function originOf(): LlmCallOrigin {
  const ctx = getRequestContext();
  if (ctx?.unattended) return "task";
  return ctx?.conversationId ? "chat" : "system";
}

/**
 * Record one priced LLM call.
 *
 * Like `origin`, the run a call belongs to comes from the scope it runs in, not
 * from the caller: `runId` is the context's `credentialSubject`, the run id the
 * model gateway charges the call to. One source for both, so the ledger's
 * per-run cost and the gateway's per-run charge name the same run. A run's
 * forked calls (title, compaction) run in its context, so they carry its run
 * and its origin: a conversation's title bills as `chat`, the conversation
 * whose work it is doing. A call outside any run carries no run and bills
 * `system`.
 *
 * `test/integration/compaction-wiring.test.ts` and
 * `mid-turn-compaction-wiring.test.ts` drive real folds and assert this off
 * `/metrics`, so a turn's call escaping its scope fails a test rather than
 * quietly recording its spend as unattributed.
 *
 * Fans out to both halves of the chokepoint: the process-local Prometheus
 * counters, and the durable ledger that survives the process.
 *
 * Every model call is spent in a workspace on behalf of a user, so a ledger line
 * always names both. A call whose scope lacks either is a call that escaped its
 * request context: it is logged as an error and kept off the ledger rather than
 * written with an owner made up, and the counters still count it.
 */
export function recordLlmCall(args: {
  source: LlmUsageSource;
  model: string;
  usage: TokenUsage;
  llmMs?: number;
}): void {
  const origin = originOf();
  recordLlmUsage(args.source, args.model, args.usage, origin);
  if (!ledger) return;

  const ctx = getRequestContext();
  const userId = ctx?.identity?.id;
  const workspaceId = ctx?.workspaceId;
  if (!userId || !workspaceId) {
    log.error("[usage] model call outside a workspace and user scope; not recorded", {
      source: args.source,
      model: args.model,
      hasUser: Boolean(userId),
      hasWorkspace: Boolean(workspaceId),
    });
    return;
  }
  // Rates are resolved at write time so a past call keeps costing what it cost.
  // Absent when the catalog does not know the model, which the reader reports
  // as unpriced rather than as zero.
  const rates = resolveRates(args.model);
  const entry: UsageLedgerEntry = {
    ts: new Date().toISOString(),
    source: args.source,
    origin,
    model: args.model,
    usage: args.usage,
    llmMs: args.llmMs ?? 0,
    userId,
    workspaceId,
    // Each id under its own name, so no reader has to consult `origin` to learn
    // what it is holding. `runId` is the run's, and it is the only one of the
    // three that is per-TURN, so it is what makes "what did this turn cost"
    // answerable at all.
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.runId ? { taskRunId: ctx.runId } : {}),
    ...(ctx.credentialSubject ? { runId: ctx.credentialSubject } : {}),
    ...(ctx.agentRuntime ? { runtime: ctx.agentRuntime } : {}),
    ...(rates ? { rates } : {}),
  };
  ledger.append(entry);
}
