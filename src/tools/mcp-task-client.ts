/**
 * The task wire, driven on the connection's own transport.
 *
 * SDK v2 carries no task client in either era. On a 2025-11-25 connection its
 * `tools/call` wire schema refuses a task-shaped result ("content is required
 * when the body carries 'task'"), and on a 2026-07-28 connection the result
 * funnel rejects `resultType: "task"` as `UnsupportedResultType` and refuses to
 * send `tasks/*` at all. The tasks extension (`io.modelcontextprotocol/tasks`,
 * SEP-2663) is tracked upstream as typescript-sdk#2189. Until it ships, the
 * runtime sends the task calls itself: a JSON-RPC request with its own id on
 * the same transport the `Client` uses (so auth, session and the era's HTTP
 * headers come from the transport as they do for every other request), and a
 * response intercepted before the `Client` sees an id it did not issue.
 *
 * Two vocabularies, chosen by the connection's negotiated era:
 *
 * - **legacy (2025-11-25):** `tools/call` with `params.task: { ttl }` answers
 *   `{ task }`; `tasks/get` polls; `tasks/result` reads the payload;
 *   `tasks/cancel` cancels.
 * - **modern (2026-07-28, SEP-2663):** the request opts in per call by naming
 *   the extension in its `_meta` client capabilities; the server alone decides
 *   whether to task it, so `tools/call` answers either a complete result or a
 *   flat task (`resultType: "task"`); `tasks/get` inlines the outcome;
 *   `tasks/cancel` cancels. `tasks/update` (mid-task input) is not driven: a
 *   task that asks for input is cancelled and reported, because this runtime
 *   has no one to ask.
 *
 * The generator's message shape is the one `McpSource.drainTaskStream`
 * consumes, and its `Task` is the 2025 shape, so everything downstream of the
 * stream is era-blind. When the SDK ships the extension this file is deleted
 * and the stream is built on its client.
 */

import type {
  CallToolResult,
  Client,
  ClientCapabilities,
  Implementation,
  JSONRPCMessage,
  MessageExtraInfo,
  Task,
  Transport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

/** The SEP-2663 extension identifier. */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** Poll cadence when the server names none. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Floor on a server-supplied poll interval, so a `0` cannot spin the loop. */
const MIN_POLL_INTERVAL_MS = 250;
/** Ceiling on one task-management request (`tasks/get`, `tasks/cancel`, …). */
const TASK_REQUEST_TIMEOUT_MS = 60_000;

/** One message from {@link callToolAsTaskStream}. */
export interface TaskStreamMessage {
  type: "taskCreated" | "taskStatus" | "result" | "error";
  task?: Task;
  result?: CallToolResult;
  error?: { message?: string };
}

type Era = "legacy" | "modern";

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/** A JSON-RPC error answered to a request this module sent. */
export class TaskWireError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "TaskWireError";
  }
}

/**
 * The task wire for one connected (client, transport) pair. Built after the
 * `Client` connects, because the interceptor wraps the `onmessage` the
 * `Client` installed and the era is known only then.
 */
export class TaskWire {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  private constructor(
    private readonly transport: Transport,
    private readonly era: Era,
    private readonly envelope: Record<string, unknown> | undefined,
  ) {}

  /**
   * Attach to a connected client. `clientInfo` and `capabilities` are what the
   * client declared; on a modern connection they form the per-request envelope
   * the SDK would have attached, plus the tasks extension this request opts in
   * to.
   */
  static attach(
    client: Client,
    transport: Transport,
    clientInfo: Implementation,
    capabilities: ClientCapabilities,
  ): TaskWire {
    const era: Era = client.getProtocolEra() === "modern" ? "modern" : "legacy";
    const version = client.getNegotiatedProtocolVersion();
    const envelope =
      era === "modern" && version
        ? {
            [PROTOCOL_VERSION_META_KEY]: version,
            [CLIENT_INFO_META_KEY]: clientInfo,
            [CLIENT_CAPABILITIES_META_KEY]: {
              ...capabilities,
              extensions: { ...(capabilities.extensions ?? {}), [TASKS_EXTENSION_ID]: {} },
            },
          }
        : undefined;
    const wire = new TaskWire(transport, era, envelope);
    const inner = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      if (wire.claim(message)) return;
      inner?.(message, extra);
    };
    const innerClose = transport.onclose;
    transport.onclose = () => {
      wire.failAll(new Error("Connection closed"));
      innerClose?.();
    };
    return wire;
  }

  /** The era this wire speaks, fixed at attach. */
  getEra(): Era {
    return this.era;
  }

  /** Settle a response to one of our requests; false for anything else. */
  private claim(message: JSONRPCMessage): boolean {
    if (!("id" in message) || typeof message.id !== "string") return false;
    if ("method" in message) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    if ("error" in message && message.error) {
      pending.reject(new TaskWireError(message.error.code, message.error.message));
    } else if ("result" in message) {
      pending.resolve(message.result as Record<string, unknown>);
    }
    return true;
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  /**
   * Send one request and resolve with its raw result. On a modern connection
   * the envelope is merged under the caller's `_meta`, the way the SDK merges
   * its own, so the transport derives the era's standard headers from it.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = `nb-task-${++this.seq}-${crypto.randomUUID()}`;
    const meta = params._meta as Record<string, unknown> | undefined;
    const withEnvelope = this.envelope
      ? { ...params, _meta: { ...this.envelope, ...meta } }
      : params;
    const timeoutMs = opts.timeoutMs ?? TASK_REQUEST_TIMEOUT_MS;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle(() => reject(new Error(`${method} aborted`)));
      const settle = (fn: () => void) => {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };
      if (opts.signal?.aborted) {
        reject(new Error(`${method} aborted`));
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => settle(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: (result) => settle(() => resolve(result)),
        reject: (err) => settle(() => reject(err)),
      });
      this.transport
        .send(
          { jsonrpc: "2.0", id, method, params: withEnvelope },
          opts.signal ? { requestSignal: opts.signal } : undefined,
        )
        .catch((err: unknown) =>
          settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
        );
    });
  }
}

function isTerminal(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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

/** A modern (flat, SEP-2663) task body, as the 2025 `Task` the runtime carries. */
function taskFromModern(raw: Record<string, unknown>): Task {
  const task: Task = {
    taskId: String(raw.taskId),
    status: raw.status as Task["status"],
    createdAt: String(raw.createdAt),
    lastUpdatedAt: String(raw.lastUpdatedAt),
    ttl: typeof raw.ttlMs === "number" ? raw.ttlMs : null,
  };
  if (typeof raw.pollIntervalMs === "number") task.pollInterval = raw.pollIntervalMs;
  if (typeof raw.statusMessage === "string") task.statusMessage = raw.statusMessage;
  return task;
}

/** A `CallToolResult` from a raw result body: the wire's discriminator removed. */
function callToolResultFrom(raw: Record<string, unknown>): CallToolResult {
  const { resultType: _resultType, ...rest } = raw;
  return { ...rest, content: Array.isArray(rest.content) ? rest.content : [] } as CallToolResult;
}

/** `tasks/get` — the current server-side state of one task. */
export async function getTask(wire: TaskWire, taskId: string): Promise<Task> {
  const raw = await wire.request("tasks/get", { taskId });
  return wire.getEra() === "modern" ? taskFromModern(raw) : (raw as unknown as Task);
}

/**
 * `tasks/result` — the payload a 2025-era task produced. The 2026 revision has
 * no such method: `tasks/get` inlines the outcome, and {@link callToolAsTaskStream}
 * reads it there.
 */
export async function getTaskResult(wire: TaskWire, taskId: string): Promise<CallToolResult> {
  if (wire.getEra() === "modern") {
    throw new Error(`tasks/result ${taskId}: the 2026-07-28 revision inlines results in tasks/get`);
  }
  return callToolResultFrom(await wire.request("tasks/result", { taskId }));
}

/**
 * `tasks/cancel` — cooperative and best-effort: the server acknowledges the
 * intent and may still finish the work. Failures are swallowed; the caller is
 * already tearing down.
 */
export async function cancelTask(wire: TaskWire, taskId: string): Promise<void> {
  try {
    await wire.request("tasks/cancel", { taskId });
  } catch {
    // Best-effort by contract.
  }
}

/**
 * Start a task-augmentable `tools/call` and drive it to a terminal state.
 *
 * A legacy server tasks every call this sends (the ttl is the request). A
 * modern server may instead answer the call outright; that arrives as a
 * `taskCreated` for an already-`completed` synthetic task followed by its
 * result, so a caller that hands out task handles (the `/mcp` endpoint) still
 * has one to hand out.
 *
 * Polling rather than a status notification: the poll is each revision's own
 * default, and one mechanism is the one that gets exercised on every connector.
 */
export async function* callToolAsTaskStream(
  wire: TaskWire,
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
  opts: { signal: AbortSignal; ttlMs: number; createTimeoutMs: number },
): AsyncGenerator<TaskStreamMessage, void, void> {
  const started = await startTask(wire, params, opts);
  if ("messages" in started) {
    yield* started.messages;
    return;
  }
  let task = started.task;
  yield { type: "taskCreated", task };

  let lastBody: Record<string, unknown> | undefined;
  while (!isTerminal(task.status)) {
    await delay(
      Math.max(task.pollInterval ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS),
      opts.signal,
    );
    const polled = await pollTask(wire, task, params.name, opts.signal);
    if ("message" in polled) {
      yield polled.message;
      return;
    }
    task = polled.task;
    lastBody = polled.body;
    yield { type: "taskStatus", task };
  }
  yield await terminalMessage(wire, task, lastBody);
}

/**
 * Send the task-augmentable `tools/call`. Resolves the task to poll, or — when
 * a modern server answered the call outright or asked for input — the whole
 * message sequence.
 */
async function startTask(
  wire: TaskWire,
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
  opts: { signal: AbortSignal; ttlMs: number; createTimeoutMs: number },
): Promise<{ task: Task } | { messages: TaskStreamMessage[] }> {
  const modern = wire.getEra() === "modern";
  const created = await wire.request(
    "tools/call",
    modern ? params : { ...params, task: { ttl: opts.ttlMs } },
    { signal: opts.signal, timeoutMs: opts.createTimeoutMs },
  );
  if (!modern) return { task: (created as { task: Task }).task };
  if (created.resultType === "task") return { task: taskFromModern(created) };
  if (created.resultType === "input_required") {
    return { messages: [{ type: "error", error: { message: inputRequiredMessage(params.name) } }] };
  }
  const now = new Date().toISOString();
  return {
    messages: [
      {
        type: "taskCreated",
        task: {
          taskId: `nb-inline-${crypto.randomUUID()}`,
          status: "completed",
          createdAt: now,
          lastUpdatedAt: now,
          ttl: null,
        },
      },
      { type: "result", result: callToolResultFrom(created) },
    ],
  };
}

/**
 * One poll. Resolves the task's new state, or the terminal message when the
 * caller abandoned the call, the poll failed, or a modern task asked for input
 * this host cannot give.
 */
async function pollTask(
  wire: TaskWire,
  task: Task,
  tool: string,
  signal: AbortSignal,
): Promise<{ task: Task; body: Record<string, unknown> } | { message: TaskStreamMessage }> {
  if (signal.aborted) {
    // Tell the server so it can stop, then report the abort as a terminal
    // error — `settleTaskError` reads `cancelRequested` to decide whether this
    // was a deliberate cancel.
    await cancelTask(wire, task.taskId);
    return {
      message: { type: "error", error: { message: `Task ${task.taskId} aborted by the caller` } },
    };
  }
  let body: Record<string, unknown>;
  try {
    body = await wire.request("tasks/get", { taskId: task.taskId });
  } catch (err) {
    return {
      message: {
        type: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
      },
    };
  }
  if (wire.getEra() === "legacy") return { task: body as unknown as Task, body };
  const next = taskFromModern(body);
  if (next.status === "input_required") {
    await cancelTask(wire, next.taskId);
    return { message: { type: "error", error: { message: inputRequiredMessage(tool) } } };
  }
  return { task: next, body };
}

/**
 * The message a terminal task ends the stream with. A completed task's result
 * is inlined in the last `tasks/get` on a modern connection and read with
 * `tasks/result` on a legacy one.
 *
 * For `failed` and `cancelled` the legacy wording is load-bearing:
 * `recoverFailedTaskResult` keys on a message ending `Task <id> failed` to
 * attempt one more `tasks/result` before settling for a bare error string. A
 * modern task inlines its JSON-RPC error, so its message is appended and no
 * recovery is attempted — there is no `tasks/result` to recover from.
 */
async function terminalMessage(
  wire: TaskWire,
  task: Task,
  lastBody: Record<string, unknown> | undefined,
): Promise<TaskStreamMessage> {
  const modern = wire.getEra() === "modern";
  if (task.status === "completed") {
    try {
      const inlined = modern ? lastBody?.result : undefined;
      const result =
        typeof inlined === "object" && inlined !== null
          ? callToolResultFrom(inlined as Record<string, unknown>)
          : await getTaskResult(wire, task.taskId);
      return { type: "result", result };
    } catch (err) {
      return {
        type: "error",
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  const inlinedError = modern ? (lastBody?.error as { message?: unknown } | undefined) : undefined;
  const detail = typeof inlinedError?.message === "string" ? `: ${inlinedError.message}` : "";
  return { type: "error", error: { message: `Task ${task.taskId} ${task.status}${detail}` } };
}

function inputRequiredMessage(tool: string): string {
  return (
    `Tool "${tool}" asked for input mid-call. This host does not answer input requests, ` +
    `so the call was cancelled.`
  );
}

/**
 * The task operations one connection offers `McpSource`: the seam between the
 * source's task bookkeeping and the wire that carries it. When the SDK ships
 * the tasks extension, an implementation over its client replaces
 * {@link taskClientFor} and nothing above this interface changes.
 */
export interface TaskClient {
  /** The era the connection negotiated; `getTaskResult` exists only on `legacy`. */
  readonly era: Era;
  callToolStream(
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
    opts: { signal: AbortSignal; ttlMs: number; createTimeoutMs: number },
  ): AsyncGenerator<TaskStreamMessage, void, void>;
  getTask(taskId: string): Promise<Task>;
  getTaskResult(taskId: string): Promise<CallToolResult>;
}

/** The {@link TaskClient} over one connection's {@link TaskWire}. */
export function taskClientFor(wire: TaskWire): TaskClient {
  return {
    era: wire.getEra(),
    callToolStream: (params, opts) => callToolAsTaskStream(wire, params, opts),
    getTask: (taskId) => getTask(wire, taskId),
    getTaskResult: (taskId) => getTaskResult(wire, taskId),
  };
}
