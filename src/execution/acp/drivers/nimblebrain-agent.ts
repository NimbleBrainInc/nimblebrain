/**
 * The driver for nimblebrain-agent, NimbleBrain's agent loop as a standalone
 * ACP agent. Its workers are dialed like any other (`../http-connection.ts`);
 * this is what nimblebrain-agent takes beyond ACP.
 *
 * NimbleBrain imports nothing of nimblebrain-agent. The driver speaks its
 * documented session options (`nimblebrain-agent/session` on `session/new`:
 * history, model, limits, compaction) and reads its documented response keys.
 * The system prompt and the turn's model access go by ACP's own fields, which
 * the generic runtime sends (`../standard-fields.ts`) and the agent takes.
 *
 * - It takes the turn's model credential per session (`providers/set`), which
 *   the door mints when the run starts.
 * - The agent's tools are the run's projection alone.
 */

import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type { ResolvedRun } from "../../types.ts";
import {
  type AcpDriver,
  type AcpOutcome,
  knownStopReason,
  type ReportedModelCall,
} from "../driver.ts";
import { userMessageToPrompt } from "../transcript.ts";

/** nimblebrain-agent's session options key (its README, "Session options"). */
export const AGENT_SESSION_META_KEY = "nimblebrain-agent/session";

/** nimblebrain-agent's response keys: its own stop reason, and the turn's model calls. */
export const AGENT_STOP_REASON_META_KEY = "nimblebrain-agent/stopReason";
export const AGENT_USAGE_META_KEY = "nimblebrain-agent/usage";

export function createNimbleBrainAgentDriver(): AcpDriver {
  return {
    capabilities: { spendGate: false, modelCredential: "session" },
    toolSurface: "projection",
    sessionMeta: (run) => agentSessionMeta(run),
    prompt: agentPrompt,
    outcome: agentOutcome,
  };
}

/** The session options for one run, in nimblebrain-agent's documented shape. */
export function agentSessionMeta(run: ResolvedRun): Record<string, unknown> {
  return {
    [AGENT_SESSION_META_KEY]: {
      history: encodeHistory(priorMessages(run)),
      model: run.config.model,
      maxIterations: run.config.maxIterations,
      maxInputTokens: run.config.maxInputTokens,
      maxOutputTokens: run.config.maxOutputTokens,
      ...(run.config.thinking ? { thinking: run.config.thinking } : {}),
      compaction: run.compaction ?? false,
    },
  };
}

/** The turn's opening prompt: the latest message, the history having gone in the session options. */
export function agentPrompt(run: ResolvedRun) {
  const latest = run.messages.at(-1);
  return latest?.role === "user" ? userMessageToPrompt(latest) : [];
}

/** What nimblebrain-agent reports beyond ACP: its stop reason, and every model call of the turn. */
export function agentOutcome(response: { _meta?: Record<string, unknown> | null }): AcpOutcome {
  const meta = response._meta ?? {};
  const stopReason = knownStopReason(meta[AGENT_STOP_REASON_META_KEY]);
  const usage = meta[AGENT_USAGE_META_KEY] as { calls?: unknown } | undefined;
  const calls = Array.isArray(usage?.calls) ? usage.calls.filter(isReportedCall) : undefined;
  return { ...(stopReason ? { stopReason } : {}), ...(calls ? { calls } : {}) };
}

function isReportedCall(value: unknown): value is ReportedModelCall {
  const c = value as Partial<ReportedModelCall> | null;
  return (
    typeof c?.model === "string" &&
    (c.purpose === "turn" || c.purpose === "summary") &&
    typeof c.usage?.inputTokens === "number" &&
    typeof c.usage.outputTokens === "number"
  );
}

/**
 * History in nimblebrain-agent's documented encoding: JSON, with a file part's bytes as
 * `{ "__nb_agent_bytes": <base64> }`.
 */
export function encodeHistory(messages: LanguageModelV4Message[]): string {
  return JSON.stringify(messages, (_key, value) =>
    value instanceof Uint8Array
      ? { __nb_agent_bytes: Buffer.from(value).toString("base64") }
      : value,
  );
}

function priorMessages(run: ResolvedRun): LanguageModelV4Message[] {
  return run.messages.at(-1)?.role === "user" ? run.messages.slice(0, -1) : run.messages;
}
