/**
 * A run whose agent lost its connection mid-turn: the worker that held the
 * connection went away (a rollout drained it, it restarted, it crashed) after
 * the connection was established. The turn cannot finish, the same as a native
 * run cut by a runtime restart, so the run fails naming the cut, and whoever
 * started it (the person, or the task's source) decides whether to run it
 * again. It is never retried mid-turn: the tools the turn already called ran.
 *
 * The connection (`./http-connection.ts`) marks a connection the worker lost,
 * and the ACP runtime (`./acp-runtime.ts`) reads the mark when the run fails.
 * The connection does not throw the error itself, so the transport closes
 * exactly as it would anyway and an abort stays an abort.
 */
export class AgentConnectionLostError extends Error {
  override readonly name = "AgentConnectionLostError";
  /** Stable across the runtime boundary, where task records classify a failure by it. */
  readonly code = "agent_connection_lost";
  constructor(cause: unknown) {
    super(
      "The agent restarted mid-turn, so this turn was cut off. Try again; tool calls made before the cut may already have run.",
      { cause },
    );
  }
}
