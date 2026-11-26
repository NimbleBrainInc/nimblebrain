/**
 * The driver for a vendor's own agent CLI (Claude Code, Codex) run as a worker
 * on the person's machine by the `nimblebrain` CLI (`npx nimblebrain use`,
 * `packages/cli/src/subscription/`), signed in to their subscription. The CLI
 * calls its vendor with its own login, so:
 *
 * - It takes no model credential and no gateway route: the run's spend is the
 *   subscription's, which nothing here can cap, so the door gives it no spend
 *   gate and sends a budgeted run to the native engine (ADR-0062).
 * - It reports each model call under a name the catalog does not price
 *   (`<cli>-subscription:<model>`), so the ledger counts tokens at $0.
 * - Claude Code's only tools are the run's projection; Codex keeps a read-only
 *   shell it cannot switch off, so it is `mixed` and runs only under the dev
 *   identity provider, on one person's machine.
 */

import type { AcpDriver, AcpOutcome, ReportedModelCall } from "../driver.ts";

/** The worker's response key: every model call of the turn. */
export const SUBSCRIPTION_USAGE_META_KEY = "nimblebrain-subscription/usage";

export function createSubscriptionCliDriver(cli: "claude-code" | "codex"): AcpDriver {
  return {
    capabilities: { spendGate: false, ownModel: `${cli}-subscription` },
    toolSurface: cli === "claude-code" ? "projection" : "mixed",
    outcome: subscriptionOutcome,
  };
}

export function subscriptionOutcome(response: {
  _meta?: Record<string, unknown> | null;
}): AcpOutcome {
  const usage = response._meta?.[SUBSCRIPTION_USAGE_META_KEY] as { calls?: unknown } | undefined;
  const calls = Array.isArray(usage?.calls) ? usage.calls.filter(isReportedCall) : undefined;
  return calls && calls.length > 0 ? { calls } : {};
}

function isReportedCall(value: unknown): value is ReportedModelCall {
  const c = value as Partial<ReportedModelCall> | null;
  return (
    typeof c?.model === "string" &&
    c.purpose === "turn" &&
    typeof c.usage?.inputTokens === "number" &&
    typeof c.usage.outputTokens === "number"
  );
}
