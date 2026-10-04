/**
 * The task surface of a kernel identity source: what the `/mcp` identity door
 * needs to run one of the source's tools as a task (the tasks extension on the
 * 2026-07-28 leg) and to answer `tasks/get` and `tasks/cancel` for it.
 *
 * A connector's tasks live in its `McpSource` (`startToolAsTask` and friends).
 * An identity source's task is its own record: the tasks source hands out
 * the run id as the task id and answers a lookup from the run's ticket on disk,
 * so the handle outlives the request, the connection, and the process.
 *
 * Ownership is the same rule as a connector task's: the (workspace, identity,
 * source) of the lookup must be the one the task was started for, and any other
 * lookup is answered exactly like a task that does not exist
 * (`TaskNotFoundError`).
 */

import type { Task } from "@modelcontextprotocol/server";
import type { TaskOwnerContext } from "./types.ts";

/** A tool result, as `tasks/get` inlines a completed task's. */
export interface IdentityTaskResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** How a call to start a task was answered. */
export type IdentityTaskStart =
  /** Started (or found already started, by idempotency key): poll this task. */
  | { task: Task }
  /** Refused before any run existed (bad arguments, no such task): the answer, inline. */
  | { result: IdentityTaskResult };

export interface IdentityTaskSource {
  /** The source's name, the `<source>` of its `<source>__<tool>` names. */
  readonly name: string;
  /** Whether the tool (bare name) may run as a task. Undefined: never. */
  taskSupport(toolName: string): "optional" | "required" | undefined;
  /**
   * Start a call as a task. Runs under the caller's request context (identity
   * and workspace), as the tool's inline call does; `ownerContext` is stamped
   * on the task and every later lookup must present the same one.
   */
  startToolAsTask(
    toolName: string,
    args: Record<string, unknown>,
    opts: { ownerContext: TaskOwnerContext },
  ): Promise<IdentityTaskStart>;
  getTaskStatus(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task>;
  /**
   * A terminal task's result. A task that failed rejects with its reason; one
   * that is not terminal waits for it; an unknown or foreign one rejects with
   * `TaskNotFoundError`.
   */
  awaitToolTaskResult(
    taskId: string,
    opts: { ownerContext: TaskOwnerContext },
  ): Promise<IdentityTaskResult>;
  /** Cancel a working task; `TaskAlreadyTerminalError` when it has ended. */
  cancelTask(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task>;
}
