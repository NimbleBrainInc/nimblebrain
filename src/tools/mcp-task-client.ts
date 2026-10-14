/**
 * The task wire, driven on the connection's own transport.
 *
 * Task augmentation is the 2026-07-28 tasks extension
 * (`io.modelcontextprotocol/tasks`, SEP-2663) and nothing else (ADR-0046): the
 * 2025-11-25 tasks utility (`params.task`, `tasks/result`) is never sent.
 *
 * SDK v2 carries no client for the extension: on a 2026-07-28 connection its
 * result funnel rejects `resultType: "task"` as `UnsupportedResultType` and
 * refuses to send `tasks/*` at all (typescript-sdk#2189). Until it ships, the
 * runtime sends the task calls itself: a JSON-RPC request with its own id on
 * the same transport the `Client` uses (so auth, session and the era's HTTP
 * headers come from the transport as they do for every other request), and a
 * response intercepted before the `Client` sees an id it did not issue.
 *
 * The request opts in per call by naming the extension in its `_meta` client
 * capabilities; the server alone decides whether to task it, so `tools/call`
 * answers either a complete result or a flat task (`resultType: "task"`);
 * `tasks/get` inlines the outcome; `tasks/cancel` cancels. `tasks/update`
 * (mid-task input) is not driven: a task that asks for input is cancelled and
 * reported, because this runtime has no one to ask.
 *
 * A 2025-era connection gets {@link inlineTaskClient}: the call runs as an
 * ordinary blocking `tools/call` and is reported as an already-completed task,
 * the same shape as a 2026 server answering outright.
 *
 * The generator's message shape is the one `McpSource.drainTaskStream`
 * consumes, and its `Task` is the SDK's `Task`, so everything downstream of the
 * stream is wire-blind. When the SDK ships the extension the wire here is
 * deleted and the stream is built on its client.
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
import { log } from "../observability/log.ts";

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
 * The task wire for one connected 2026-07-28 (client, transport) pair. Built
 * after the `Client` connects, because the interceptor wraps the `onmessage`
 * the `Client` installed and the era is known only then.
 */
export class TaskWire {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  private constructor(
    /** The source this connection belongs to, for log lines. */
    readonly source: string,
    private readonly transport: Transport,
    private readonly envelope: Record<string, unknown>,
  ) {}

  /**
   * Attach to a connected 2026-07-28 client, or null on any other era: a
   * 2025-era connection has no task wire. `clientInfo` and `capabilities` are
   * what the client declared; they form the per-request envelope the SDK would
   * have attached, plus the tasks extension this request opts in to.
   */
  static attach(
    source: string,
    client: Client,
    transport: Transport,
    clientInfo: Implementation,
    capabilities: ClientCapabilities,
  ): TaskWire | null {
    const version = client.getNegotiatedProtocolVersion();
    if (client.getProtocolEra() !== "modern" || !version) return null;
    const envelope = {
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: {
        ...capabilities,
        extensions: { ...(capabilities.extensions ?? {}), [TASKS_EXTENSION_ID]: {} },
      },
    };
    const wire = new TaskWire(source, transport, envelope);
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
   * Send one request and resolve with its raw result. The envelope is merged
   * under the caller's `_meta`, the way the SDK merges its own, so the
   * transport derives the era's standard headers from it.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = `nb-task-${++this.seq}-${crypto.randomUUID()}`;
    const meta = params._meta as Record<string, unknown> | undefined;
    const withEnvelope = { ...params, _meta: { ...this.envelope, ...meta } };
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

/** A flat SEP-2663 task body, as the SDK `Task` the runtime carries. */
function taskFromWire(raw: Record<string, unknown>): Task {
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
  return taskFromWire(await wire.request("tasks/get", { taskId }));
}

/**
 * `tasks/cancel` — cooperative and best-effort: the server acknowledges the
 * intent and may still finish the work. A failure does not reach the caller,
 * which is already tearing down, but it is logged: it means the remote job may
 * still be running.
 */
export async function cancelTask(wire: TaskWire, taskId: string): Promise<void> {
  try {
    await wire.request("tasks/cancel", { taskId });
  } catch (err) {
    log.warn("[mcp] tasks/cancel failed; the remote task may still be running", {
      source: wire.source,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start a task-augmentable `tools/call` and drive it to a terminal state.
 *
 * The server may answer the call outright instead; that arrives as a
 * `taskCreated` for an already-`completed` synthetic task followed by its
 * result, so a caller that hands out task handles (the `/mcp` endpoint) still
 * has one to hand out.
 *
 * Polling rather than a status notification: the poll is each revision's own
 * default, and one mechanism is the one that gets exercised on every connector.
 */
export async function* callToolAsTaskStream(
  wire: TaskWire,
  params: TaskCallParams,
  opts: { signal: AbortSignal; createTimeoutMs: number },
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
  yield terminalMessage(task, lastBody);
}

/**
 * Send the task-augmentable `tools/call`. Resolves the task to poll, or — when
 * the server answered the call outright or asked for input — the whole message
 * sequence.
 */
async function startTask(
  wire: TaskWire,
  params: TaskCallParams,
  opts: { signal: AbortSignal; createTimeoutMs: number },
): Promise<{ task: Task } | { messages: TaskStreamMessage[] }> {
  const created = await wire.request("tools/call", params, {
    signal: opts.signal,
    timeoutMs: opts.createTimeoutMs,
  });
  if (created.resultType === "task") return { task: taskFromWire(created) };
  if (created.resultType === "input_required") {
    return { messages: [{ type: "error", error: { message: inputRequiredMessage(params.name) } }] };
  }
  return { messages: answeredOutright(callToolResultFrom(created)) };
}

/**
 * A call that was answered without a task, as the stream reports it: a
 * synthetic `nb-inline-*` task, already `completed`, then its result.
 */
function answeredOutright(result: CallToolResult): TaskStreamMessage[] {
  const now = new Date().toISOString();
  return [
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
    { type: "result", result },
  ];
}

/**
 * One poll. Resolves the task's new state, or the terminal message when the
 * caller abandoned the call, the poll failed, or the task asked for input this
 * host cannot give.
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
  const next = taskFromWire(body);
  if (next.status === "input_required") {
    await cancelTask(wire, next.taskId);
    return { message: { type: "error", error: { message: inputRequiredMessage(tool) } } };
  }
  return { task: next, body };
}

/**
 * The message a terminal task ends the stream with. `tasks/get` inlines the
 * outcome: a completed task's result, or the JSON-RPC error a failed one ended
 * with, whose message is appended to the status.
 */
function terminalMessage(
  task: Task,
  lastBody: Record<string, unknown> | undefined,
): TaskStreamMessage {
  if (task.status === "completed") {
    const inlined = lastBody?.result;
    if (typeof inlined === "object" && inlined !== null) {
      return { type: "result", result: callToolResultFrom(inlined as Record<string, unknown>) };
    }
    return {
      type: "error",
      error: { message: `Task ${task.taskId} completed without an inlined result` },
    };
  }
  const inlinedError = lastBody?.error as { message?: unknown } | undefined;
  const detail = typeof inlinedError?.message === "string" ? `: ${inlinedError.message}` : "";
  return { type: "error", error: { message: `Task ${task.taskId} ${task.status}${detail}` } };
}

function inputRequiredMessage(tool: string): string {
  return (
    `Tool "${tool}" asked for input mid-call. This host does not answer input requests, ` +
    `so the call was cancelled.`
  );
}

/** The `tools/call` a {@link TaskClient} starts. */
export type TaskCallParams = {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * The task operations one connection offers `McpSource`: the seam between the
 * source's task bookkeeping and the wire that carries it. When the SDK ships
 * the tasks extension, an implementation over its client replaces
 * {@link taskClientFor} and nothing above this interface changes.
 */
export interface TaskClient {
  callToolStream(
    params: TaskCallParams,
    opts: { signal: AbortSignal; createTimeoutMs: number },
  ): AsyncGenerator<TaskStreamMessage, void, void>;
  getTask(taskId: string): Promise<Task>;
}

/** The {@link TaskClient} over one 2026-07-28 connection's {@link TaskWire}. */
export function taskClientFor(wire: TaskWire): TaskClient {
  return {
    callToolStream: (params, opts) => callToolAsTaskStream(wire, params, opts),
    getTask: (taskId) => getTask(wire, taskId),
  };
}

/**
 * The {@link TaskClient} for a connection with no task wire (a 2025-era one):
 * `call` runs the tool as an ordinary blocking `tools/call`, and the stream
 * reports it as an already-completed task. No task is ever attached, so there
 * is no server-side task to get.
 */
export function inlineTaskClient(
  call: (params: TaskCallParams, signal: AbortSignal) => Promise<CallToolResult>,
): TaskClient {
  return {
    async *callToolStream(params, opts) {
      yield* answeredOutright(await call(params, opts.signal));
    },
    getTask: (taskId) =>
      Promise.reject(new Error(`No task ${taskId}: this connection runs calls inline`)),
  };
}
