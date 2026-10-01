import {
  credentialStorePlaintextAccepted,
  credentialStoreSealed,
  llmErrorsTotal,
  llmInputTokensEstimatedTotal,
  llmRequestDurationSeconds,
  llmTtftSeconds,
  recordConnectorCrash,
  recordCredentialSealFailure,
  toolCallsTotal,
  toolPromotionsTotal,
} from "../api/metrics.ts";
import { dispatchEngineEvent, type EngineEventHandlers } from "../engine/event-dispatch.ts";
import type {
  ConnectorHealthPayload,
  CredentialSealFailurePayload,
  CredentialStoreReconciledPayload,
  LlmDonePayload,
  LlmErrorPayload,
  RunDonePayload,
  RunErrorPayload,
  ToolDonePayload,
  ToolPromotionChangedPayload,
} from "../engine/schemas/events.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import { isSealFailureReason } from "../tools/credential-store.ts";
import { originOf, recordLlmCall } from "../usage/record.ts";

/**
 * Defensive cap on in-flight runs tracked for promoted-but-never-called. A run
 * is dropped on its `run.done`/`run.error`; this only bounds the leak from a
 * run whose terminator never fires (e.g. process death mid-run).
 */
export const MAX_TRACKED_RUNS = 1000;

/**
 * Translates engine events into Prometheus counters (see `api/metrics.ts`).
 *
 * Observe-only and process-local: it only increments in-memory counters, so it
 * is always safe to wire in — in-cluster the counters are scraped per tenant
 * pod, and in a local `bun run dev` they simply accumulate, unscraped, with no
 * Prometheus or k8s required.
 *
 * Covers the main agentic loop. The forked fast-slot calls (compaction
 * summarizer, auto-title) emit no `llm.done`, so their usage is
 * recorded at their own call sites via `recordLlmCall(...)` — which is also
 * where their `origin` is derived, since not all of them run inside a request
 * scope (see `src/usage/record.ts`).
 *
 * Promotions are counted at run end, not at promote time, so each is labeled by
 * whether the model actually called the promoted tool — the wasted-promotion
 * signal. State is keyed by `runId` and dropped on the run terminator.
 */
export class MetricsEventSink implements EventSink {
  private readonly runs = new Map<string, { promoted: Set<string>; called: Set<string> }>();

  /** Per-event-type metric handlers; event types with no metric are absent. */
  private readonly handlers: EngineEventHandlers = {
    "llm.done": (data) => this.onLlmDone(data),
    "llm.error": (data) => this.onLlmError(data),
    "tool.done": (data) => this.onToolDone(data),
    "tool.promoted": (data) => this.onToolPromoted(data),
    "run.done": (data) => this.onRunDone(data),
    "run.error": (data) => this.onRunError(data),
    "connector.health": (data) => this.onConnectorHealth(data),
    "audit.credential_seal_failure": (data) => this.onCredentialSealFailure(data),
    "credential_store.reconciled": (data) => this.onCredentialStoreReconciled(data),
  };

  emit(event: EngineEvent): void {
    dispatchEngineEvent(this.handlers, event);
  }

  /** Record main-loop LLM usage and per-call latency for a completed provider call. */
  private onLlmDone(data: LlmDonePayload): void {
    const { model, usage } = data;
    // `data` carries the engine's `runId`; `recordLlmCall` reads attribution
    // off the event and the ambient request scope rather than being told, so a
    // new call path cannot forget to say who it was for.
    recordLlmCall({ source: "main", model, usage, llmMs: data.llmMs, event: data });
    // Both latency histograms carry `origin` because latency means different
    // things depending on who is waiting: `chat` is a person watching a spinner,
    // `task` is an automation nobody is watching. Blended, a p99 says neither —
    // an alert on it fires the same for a slow overnight run as for a stalled
    // user turn.
    const origin = originOf();
    // Per-call latency for the p99 alert; the engine measures it around the
    // provider call.
    llmRequestDurationSeconds.observe({ source: "main", model, origin }, data.llmMs / 1000);
    // Time-to-first-token (connect + prefill), the prefill-vs-decode
    // discriminator. Absent when the call emitted no output part — skip rather
    // than record a misleading 0.
    const ttftMs = data.ttftMs;
    if (typeof ttftMs === "number") {
      llmTtftSeconds.observe({ source: "main", model, origin }, ttftMs / 1000);
    }
    // Pre-flight estimate for this call. Its counterpart is the input side of
    // `nb_llm_tokens_total`; dividing actual by estimated gives the estimator's
    // drift, which is what the windowing budget is silently subject to.
    //
    // Both sides of that ratio must move together or not at all. The actual
    // side records nothing for a zero input — `recordLlmUsage` gates every
    // per-kind increment on `> 0`, and the adapter skips it entirely without
    // usage — so recording an estimate there would advance the denominator
    // alone. That biases the ratio toward 1.0 or below, which reads as "no
    // drift": the one direction this metric exists to rule out. A stream that
    // ends without a finish part reaches exactly that state, leaving the usage
    // totals at their zero initializers.
    const estimated = data.estimatedInputTokens;
    if (estimated > 0 && usage.inputTokens > 0) {
      llmInputTokensEstimatedTotal.inc({ source: "main", model, origin }, estimated);
    }
  }

  /** Count a terminal provider failure toward the LLM error rate. */
  private onLlmError(data: LlmErrorPayload): void {
    // Terminal provider failure after retries (aborts excluded upstream).
    // Pairs with nb_llm_calls_total to form the error rate.
    llmErrorsTotal.inc({ source: "main", model: data.model });
  }

  /** Count the tool call and note it as called for its run's promotion tracking. */
  private onToolDone(data: ToolDonePayload): void {
    toolCallsTotal.inc({ ok: data.ok ? "true" : "false" });
    this.run(data.runId).called.add(data.name);
  }

  /** Track a tool promotion so run end can label it used-or-not. */
  private onToolPromoted(data: ToolPromotionChangedPayload): void {
    this.run(data.runId).promoted.add(data.toolName);
  }

  /** Flush the run's promotion samples on normal completion. */
  private onRunDone(data: RunDonePayload): void {
    this.finalizeRun(data.runId);
  }

  /** Flush the failed run's promotion samples. */
  private onRunError(data: RunErrorPayload): void {
    this.finalizeRun(data.runId);
  }

  /** Count a connector the health monitor found down. */
  private onConnectorHealth(data: ConnectorHealthPayload): void {
    // `connector.crashed` is the canonical crash signal: one per HealthMonitor
    // sweep that finds a source down, the per-sweep cadence the alert
    // thresholds on.
    if (data.event === "connector.crashed") {
      recordConnectorCrash(data.source, data.remote === true);
    }
  }

  /** Count a secret that failed to open, re-seal, or was refused as plaintext. */
  private onCredentialSealFailure(data: CredentialSealFailurePayload): void {
    // The store emits only the closed set; anything else is a new reason that
    // has not been added to it, and must not mint a series on its own.
    if (isSealFailureReason(data.reason)) recordCredentialSealFailure(data.reason);
  }

  /** Record whether the store is sealed, and whether its boot sweep left it accepting plaintext. */
  private onCredentialStoreReconciled(data: CredentialStoreReconciledPayload): void {
    const { sealed } = data;
    credentialStoreSealed.set(sealed ? 1 : 0);
    credentialStorePlaintextAccepted.set(sealed && !data.strictPlaintextRefusal ? 1 : 0);
  }

  /** Get (or lazily create) the per-run promoted/called tracking state. */
  private run(runId: string): { promoted: Set<string>; called: Set<string> } {
    let r = this.runs.get(runId);
    if (!r) {
      r = { promoted: new Set(), called: new Set() };
      this.runs.set(runId, r);
      if (this.runs.size > MAX_TRACKED_RUNS) {
        const oldest = this.runs.keys().next().value;
        if (oldest !== undefined) {
          this.runs.delete(oldest);
          // Should be unreachable in practice (run terminators always fire, so
          // tracked runs drain). Surface it rather than dropping the evicted
          // run's promotion samples silently — a leak this big means a
          // regressed terminator, not normal load.
          log.warn(
            `[metrics] tracked-run cap (${MAX_TRACKED_RUNS}) exceeded; dropping run ${oldest} — its promotion metrics are lost. A run terminator (run.done/run.error) likely failed to fire.`,
          );
        }
      }
    }
    return r;
  }

  /** Emit one promotion sample per promoted tool, labeled used=true|false. */
  private finalizeRun(runId: string | undefined): void {
    if (!runId) return;
    const r = this.runs.get(runId);
    if (!r) return;
    for (const tool of r.promoted) {
      toolPromotionsTotal.inc({ used: r.called.has(tool) ? "true" : "false" });
    }
    this.runs.delete(runId);
  }
}
