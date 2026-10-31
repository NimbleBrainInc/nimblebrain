/**
 * An ACP runtime is a connection and a driver. The connection is how the agent
 * is reached (a worker over the network, `./http-connection.ts`), whichever
 * agent it is. The driver is what one agent needs that ACP v1 does not say:
 * how the door's prompt, history, model and credential reach it, and what it
 * reports back. Everything else is the generic ACP runtime's
 * (`./acp-runtime.ts`), which never names an agent.
 *
 * A new ACP agent is a new driver. If a driver needs more than these hooks,
 * that is a finding about the seam, not a reason to branch the runtime.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { StopReason } from "../../engine/types.ts";
import type { TokenUsage } from "../../usage/types.ts";
import type { ResolvedRun, RuntimeCapabilities } from "../types.ts";

/** An open connection to an agent, and how to end it and everything it started. */
export interface AcpConnectionTarget {
  /** A byte stream to the agent (stdio, a socket), or an agent app in this process. */
  target: acp.Stream | acp.AgentApp;
  /**
   * The session's working directory, absolute. The connection owns it: a
   * driver that isolates an agent gives it a directory of its own per run, and
   * `close` removes it.
   */
  cwd: string;
  /**
   * Whether the agent's side lost the connection after it was established (a
   * worker that went away mid-run), for a connection that can tell. A run that
   * fails on a lost connection ends as `AgentConnectionLostError`.
   */
  lost?(): boolean;
  close(): Promise<void>;
}

/** How an agent is reached: a fresh connection, and the agent's workspace, for one run. */
export interface AcpConnection {
  open(run: ResolvedRun): Promise<AcpConnectionTarget>;
}

/** The agent-side calls a driver may make while preparing a session. */
export interface AcpSessionCalls {
  request<Response = unknown>(method: string, params: unknown): Promise<Response>;
}

/** What `session/new` will carry, for a driver that must restate it in its agent's own terms. */
export interface AcpSessionPlan {
  /** The MCP servers the session is given: the run's tool projection. */
  mcpServers: acp.McpServer[];
  /** What the runtime already delivered by ACP's own fields (`./standard-fields.ts`). */
  delivered: AcpStandardDelivery;
}

/**
 * What the generic runtime handed the agent by ACP's standard fields, for a
 * driver to leave out of its own delivery: the system prompt (`systemPrompt`
 * on `session/new`) and the run's model access (`providers/*`).
 */
export interface AcpStandardDelivery {
  systemPrompt: boolean;
  modelAccess: boolean;
}

const STOP_REASONS = new Set<string>([
  "complete",
  "max_iterations",
  "max_input_tokens",
  "spend_limit",
  "length",
  "content_filter",
  "error",
  "other",
  "cancelled",
] satisfies StopReason[]);

/** A stop reason an agent reported, when it is one the engine knows. */
export function knownStopReason(value: unknown): StopReason | undefined {
  return typeof value === "string" && STOP_REASONS.has(value) ? (value as StopReason) : undefined;
}

/** One model call an agent says its turn made. */
export interface ReportedModelCall {
  model: string;
  /** A loop iteration, or a summary written to fold the turn's history. */
  purpose: "turn" | "summary";
  usage: TokenUsage;
}

/**
 * What an agent reported about its turn beyond ACP's response, in
 * NimbleBrain's terms. Every field is optional: what a driver cannot read
 * falls back to ACP's `stopReason` and `usage`.
 */
export interface AcpOutcome {
  /** The agent's own stop reason, finer than ACP's. */
  stopReason?: StopReason;
  /** Every model call of the turn, in the order they finished. */
  calls?: ReportedModelCall[];
}

/**
 * A turn that failed on a model call, as the agent reported it: the call's HTTP
 * status, the provider's reason, and what the turn did before it.
 */
export interface AcpModelFailure {
  status: number;
  reason?: string;
  outcome: AcpOutcome;
}

export interface AcpDriver {
  /**
   * What the agent holds a run to on its own, and which model credential it
   * takes (`RuntimeCapabilities`). Absent, nothing: an agent reached over ACP
   * is given no spend gate, so only one whose model calls pass through a
   * gateway that enforces the run's budget may claim it.
   */
  readonly capabilities?: Omit<RuntimeCapabilities, "usage">;
  /**
   * Whether every tool the agent can call is one the run's tool projection
   * serves. A driver says `projection` only when it configures the agent with
   * no tools of its own; then any permission request is for a projected tool,
   * which the projection checks again when it runs, and is allowed. Otherwise
   * a request is allowed only when its title names a projected tool, and ACP
   * gives no field that names one reliably.
   */
  readonly toolSurface: "projection" | "mixed";
  /** `_meta` for `session/new`, for an agent that takes extensions there. */
  sessionMeta?(run: ResolvedRun, plan: AcpSessionPlan): Record<string, unknown>;
  /** After `session/new`, before the first prompt: deliver what the agent takes by its own methods. */
  prepareSession?(calls: AcpSessionCalls, sessionId: string, run: ResolvedRun): Promise<void>;
  /**
   * The prompt that opens the turn. Absent, the runtime sends the door's
   * history as a transcript ahead of the latest message, the one delivery every
   * ACP agent can read, with the system prompt in it unless it went by ACP's
   * `systemPrompt`.
   */
  prompt?(run: ResolvedRun): acp.ContentBlock[];
  /** Read what the agent reported about its turn in its own terms (`_meta` on the response). */
  outcome?(response: acp.PromptResponse): AcpOutcome;
  /**
   * Read the model call that failed the turn from the agent's `session/prompt`
   * error, in its own terms, or `undefined` when the error reports none.
   */
  modelFailure?(err: unknown): AcpModelFailure | undefined;
}
