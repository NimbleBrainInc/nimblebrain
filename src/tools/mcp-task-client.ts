/**
 * The task wire surface, driven directly.
 *
 * SDK v1 carried this behind `client.experimental.tasks`. v2 has no equivalent:
 * tasks left the core specification (SEP-2663) to become the
 * `io.modelcontextprotocol/tasks` extension, and no SDK implements that
 * extension yet — `modelcontextprotocol/ext-tasks` publishes a specification
 * and a schema, not a runtime. So the runtime drives the wire itself, against
 * the 2025-11-25 schemas v2 still exports as interop vocabulary.
 *
 * **Legacy-era only, and the SDK enforces it.** v2's wire registry defines
 * `tasks/*` on the 2025 era and not on 2026-07-28, so an outbound `tasks/get`
 * on a modern connection dies locally with
 * `MethodNotSupportedByProtocolVersion` before it reaches the transport. That
 * is the correct outcome — the 2026 vocabulary is a different shape
 * (`resultType: "task"`, `ttlMs`, a `tasks/update` round for mid-flight input)
 * and guessing at it would be worse than refusing. {@link assertTasksAvailable}
 * turns the SDK's error into one that names the cause.
 *
 * The generator's message shape is v1's, deliberately: `McpSource.drainTaskStream`
 * and everything downstream of it consume that contract, and reproducing it here
 * keeps the swap to one call site.
 */

import type { Client } from "@modelcontextprotocol/client";
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
} from "@modelcontextprotocol/core";
import type { CallToolResult, Task } from "@modelcontextprotocol/server";

/** Poll cadence when the server names none. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Floor on a server-supplied `pollInterval`, so a `0` cannot spin the loop. */
const MIN_POLL_INTERVAL_MS = 250;

/**
 * One message from {@link callToolAsTaskStream}. Mirrors the v1 SDK's task
 * stream so the drainer that reads it did not have to change.
 */
export interface TaskStreamMessage {
  type: "taskCreated" | "taskStatus" | "result" | "error";
  task?: Task;
  result?: CallToolResult;
  error?: { message?: string };
}

function isTerminal(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Reject a task operation on a connection whose negotiated era has no task
 * methods, with a message that says why rather than leaving the SDK's
 * registry-shaped error to be read as a bug.
 */
export function assertTasksAvailable(client: Client, what: string): void {
  const era = client.getProtocolEra();
  if (era === "modern") {
    throw new Error(
      `${what}: task augmentation is unavailable on a 2026-07-28 connection. ` +
        `Tasks moved to the io.modelcontextprotocol/tasks extension (SEP-2663), ` +
        `which no SDK implements yet; this runtime speaks the 2025-11-25 task ` +
        `methods, which that revision does not define.`,
    );
  }
}

/** Sleep, resolving early when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** `tasks/get` — the current server-side state of one task. */
export async function getTask(client: Client, taskId: string): Promise<Task> {
  assertTasksAvailable(client, `tasks/get ${taskId}`);
  return client.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);
}

/**
 * `tasks/result` — the payload a completed task produced, in the shape the
 * original request would have returned synchronously.
 */
export async function getTaskResult(client: Client, taskId: string): Promise<CallToolResult> {
  assertTasksAvailable(client, `tasks/result ${taskId}`);
  const payload = await client.request(
    { method: "tasks/result", params: { taskId } },
    GetTaskPayloadResultSchema,
  );
  return CallToolResultSchema.parse(payload);
}

/**
 * `tasks/cancel` — cooperative. The server acknowledges the intent; it is not
 * obliged to stop the work, and the task may still reach a non-`cancelled`
 * terminal status. Failures are swallowed: cancellation is best-effort and the
 * caller is already tearing down.
 */
export async function cancelTask(client: Client, taskId: string): Promise<void> {
  try {
    assertTasksAvailable(client, `tasks/cancel ${taskId}`);
    await client.request({ method: "tasks/cancel", params: { taskId } }, CancelTaskResultSchema);
  } catch {
    // Best-effort by contract.
  }
}

/**
 * Start a task-augmented `tools/call` and drive it to a terminal state,
 * yielding the same message sequence the v1 SDK stream did.
 *
 * `params.task` carries the ttl inline. v1 needed it threaded through the
 * request *options* because `Protocol.request` stamped `params.task` from
 * `options.task` after reading the caller's params; v2 has no such seam, so
 * the params are the params.
 *
 * Polling rather than `notifications/tasks/status`: the notification is an
 * optimisation over the poll, the poll is the wire's own default, and one
 * mechanism is the one that gets exercised on every connector.
 */
export async function* callToolAsTaskStream(
  client: Client,
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
  opts: { signal: AbortSignal; ttlMs: number },
): AsyncGenerator<TaskStreamMessage, void, void> {
  assertTasksAvailable(client, `tools/call ${params.name}`);

  const created = await client.request(
    { method: "tools/call", params: { ...params, task: { ttl: opts.ttlMs } } },
    CreateTaskResultSchema,
    { signal: opts.signal },
  );

  let task = created.task;
  yield { type: "taskCreated", task };

  while (!isTerminal(task.status)) {
    await delay(
      Math.max(task.pollInterval ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS),
      opts.signal,
    );

    if (opts.signal.aborted) {
      // The caller abandoned the call. Tell the server so it can stop, then
      // report the abort as a terminal error — `settleTaskError` reads
      // `cancelRequested` to decide whether this was a deliberate cancel.
      await cancelTask(client, task.taskId);
      yield { type: "error", error: { message: `Task ${task.taskId} aborted by the caller` } };
      return;
    }

    try {
      task = await getTask(client, task.taskId);
    } catch (err) {
      yield {
        type: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      return;
    }
    yield { type: "taskStatus", task };
  }

  if (task.status === "completed") {
    try {
      yield { type: "result", result: await getTaskResult(client, task.taskId) };
    } catch (err) {
      yield {
        type: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
    return;
  }

  // `failed` and `cancelled`. The wording is load-bearing and is v1's verbatim:
  // `recoverFailedTaskResult` keys on `Task <id> failed` to attempt one more
  // `tasks/result` before settling for a bare error string, which is how a
  // connector that misclassified a completed task still surfaces its payload.
  // The server's `statusMessage` is not folded in — it would break that match,
  // and the handle carries the task itself either way.
  yield { type: "error", error: { message: `Task ${task.taskId} ${task.status}` } };
}
