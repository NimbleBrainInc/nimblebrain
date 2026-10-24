/**
 * What one ACP agent needs that ACP v1 does not say: how to reach it, and how
 * the door's prompt and history reach it. Everything else is the generic ACP
 * runtime's (`./acp-runtime.ts`), which never names an agent.
 *
 * A new ACP agent is a new driver. If a driver needs more than these hooks,
 * that is a finding about the seam, not a reason to branch the runtime.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { ResolvedRun } from "../types.ts";

/** An open connection to an agent, and how to end it and everything it started. */
export interface AcpConnectionTarget {
  /** A byte stream to the agent (stdio, a socket), or an agent app in this process. */
  target: acp.Stream | acp.AgentApp;
  close(): Promise<void>;
}

/** The agent-side calls a driver may make while preparing a session. */
export interface AcpSessionCalls {
  request<Response = unknown>(method: string, params: unknown): Promise<Response>;
}

export interface AcpDriver {
  readonly id: string;
  /** Open a fresh connection for one run. */
  open(run: ResolvedRun): Promise<AcpConnectionTarget>;
  /** The session's working directory, absolute. */
  cwd(run: ResolvedRun): string;
  /** `_meta` for `session/new`, for an agent that takes extensions there. */
  sessionMeta?(run: ResolvedRun): Record<string, unknown>;
  /** After `session/new`, before the first prompt: deliver what the agent takes by its own methods. */
  prepareSession?(calls: AcpSessionCalls, sessionId: string, run: ResolvedRun): Promise<void>;
  /**
   * The prompt that opens the turn. Absent, the runtime sends the door's
   * system prompt and history as a transcript ahead of the latest message,
   * the one delivery every ACP agent can read.
   */
  prompt?(run: ResolvedRun): acp.ContentBlock[];
}
