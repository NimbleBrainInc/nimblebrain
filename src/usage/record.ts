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
import type { LlmCallOrigin, TokenUsage } from "./types.ts";

/**
 * Who this call was for, from the ambient request context alone.
 *
 * `unattended` is checked first and wins outright: an automation's context also
 * carries a `conversationId` (`executeTask` stamps the run id there so files the
 * run creates stay traceable), so testing for a conversation first would file
 * every automation call under `chat`.
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
 */
export function recordLlmCall(args: {
  source: LlmUsageSource;
  model: string;
  usage: TokenUsage;
  event?: Record<string, unknown>;
}): void {
  recordLlmUsage(args.source, args.model, args.usage, originOf(), isDelegated(args.event));
}
