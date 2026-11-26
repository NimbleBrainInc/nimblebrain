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

import type { AcpAgentFailure, AcpDriver, AcpOutcome, ReportedModelCall } from "../driver.ts";

/** The worker's response key: every model call of the turn. */
export const SUBSCRIPTION_USAGE_META_KEY = "nimblebrain-subscription/usage";
/** The worker's `initialize` key: the plan its CLI is signed in to (`Claude Max`). */
export const SUBSCRIPTION_PLAN_META_KEY = "nimblebrain-subscription/plan";
/** The worker's `initialize` key: the model its turns run on, as a person names it (`Sonnet`). */
export const SUBSCRIPTION_MODEL_META_KEY = "nimblebrain-subscription/model";
/** The `session/new` key that marks the door's own model work: `{ purpose: "internal" }`. */
export const SUBSCRIPTION_SESSION_META_KEY = "nimblebrain-subscription/session";
/** The worker's `session/prompt` error key: why the turn failed, `{ code, message }`. */
export const SUBSCRIPTION_FAILURE_META_KEY = "nimblebrain-subscription/failure";

const TITLES = { "claude-code": "Claude Code", codex: "Codex" } as const;

export function createSubscriptionCliDriver(cli: "claude-code" | "codex"): AcpDriver {
  return {
    title: TITLES[cli],
    // The worker is the `nimblebrain` CLI's; `up` starts it again.
    unreachableFix:
      "Start it on this machine with `npx nimblebrain up`, then send your message again.",
    capabilities: { spendGate: false, ownModel: `${cli}-subscription` },
    toolSurface: cli === "claude-code" ? "projection" : "mixed",
    outcome: subscriptionOutcome,
    describe: subscriptionDescription,
    // The door's own model work runs on the worker's fast model with no tool
    // connection; a turn carries no marker.
    sessionMeta: (run) =>
      run.internal ? { [SUBSCRIPTION_SESSION_META_KEY]: { purpose: "internal" } } : {},
    agentFailure: subscriptionFailure,
  };
}

/** The plan the worker says its CLI bills, from its `initialize` answer. */
export function subscriptionDescription(init: { _meta?: Record<string, unknown> | null }): {
  plan?: string;
  model?: string;
} {
  const text = (key: string) => {
    const value = init._meta?.[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined;
  };
  const plan = text(SUBSCRIPTION_PLAN_META_KEY);
  const model = text(SUBSCRIPTION_MODEL_META_KEY);
  return { ...(plan ? { plan } : {}), ...(model ? { model } : {}) };
}

/** Why the worker says the turn failed, from its `session/prompt` error's `data`. */
export function subscriptionFailure(err: unknown): AcpAgentFailure | undefined {
  const data = (err as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return undefined;
  const failure = (data as Record<string, unknown>)[SUBSCRIPTION_FAILURE_META_KEY] as
    | { code?: unknown; message?: unknown }
    | undefined;
  if (typeof failure?.code !== "string" || !/^[a-z_]{1,32}$/.test(failure.code)) return undefined;
  if (typeof failure.message !== "string" || !failure.message.trim()) return undefined;
  return { code: failure.code, message: failure.message.trim().slice(0, 500) };
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
