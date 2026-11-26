/**
 * A run an agent runtime could not execute, for a reason a person can act on:
 * its worker does not answer, or the agent reported why its turn failed (a
 * signed-out CLI, a plan's limit). `code` reaches the chat as the stream
 * error's code and `message` is shown as written, so it names the fix.
 */
export class AgentRuntimeError extends Error {
  override readonly name = "AgentRuntimeError";

  constructor(
    /** `agent_unreachable`, or `agent_<code>` for a failure the agent classified. */
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
