/**
 * The tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) at
 * `/mcp/<wsId>`: the server half of what
 * `src/tools/mcp-task-client.ts` drives as a client.
 *
 * SDK v2 produces no task result and routes no `tasks/*` method: a handler
 * registered for `tasks/get` is never reached, because the SDK answers the
 * method `Method not found` before dispatch (typescript-sdk#2189). So a
 * `tools/call` handler returns the flat task itself, and `tasks/get` and
 * `tasks/cancel` are answered here, ahead of the SDK. When the SDK ships the
 * extension, this file is deleted and the door registers the SDK's handlers.
 *
 * The door holds no task state. A task runs on the connector that started it
 * (`McpSource.startToolAsTask`), which stamps the task with the (workspace,
 * identity, source) that asked and refuses every other lookup as not found. The
 * task id the door hands out names that source beside the connector's own id,
 * so any request can find its way back: there is no session to keep a table
 * in, and none is needed.
 */

import {
  type CallToolResult,
  PROTOCOL_VERSION_META_KEY,
  type Task,
} from "@modelcontextprotocol/server";
import { TASKS_EXTENSION_ID } from "../tools/mcp-task-client.ts";
import {
  TaskAlreadyTerminalError,
  TaskNotFoundError,
  type TaskOwnerContext,
} from "../tools/types.ts";
import type { McpTaskAnswer, McpTaskAnswerBody } from "./schemas/responses.ts";
import { json } from "./types.ts";

export { TASKS_EXTENSION_ID };

/**
 * The task surface of a source the door can answer polls for: a connector's
 * `McpSource`, or a kernel identity source's task surface. Each checks the
 * caller's owner context against the one stamped when the task started.
 */
export interface TaskAwareSource {
  getTaskStatus(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task>;
  awaitToolTaskResult(
    taskId: string,
    opts: { ownerContext: TaskOwnerContext },
  ): Promise<{
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }>;
  cancelTask(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task>;
}

/**
 * The one source a task request is for, in the workspace the request is bound
 * to. The iframe bridge names the app's server this way; a scoped request finds
 * only a task that source ran in that workspace.
 */
export interface TaskScope {
  source: string;
  /** The request's validated workspace. None reaches no workspace's task. */
  workspaceId: string | undefined;
}

/** A task's own fields on the 2026-07-28 wire (SEP-2663 `Task`). */
interface ModernTaskFields {
  taskId: string;
  status: Task["status"];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

/** A `tools/call` answered with a task (SEP-2663 `CreateTaskResult`, flat). */
export type ModernCreateTaskResult = ModernTaskFields & { resultType: "task" };

/** Whether a request's client capabilities opt in to the tasks extension. */
export function optsInToTasks(clientCapabilities: unknown): boolean {
  const extensions = (clientCapabilities as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
  return extensions?.[TASKS_EXTENSION_ID] !== undefined;
}

/**
 * The id the door hands out for a task `source` started: the source and the
 * connector's own task id, base64url-encoded. A connector mints its own ids, so
 * two sources can mint the same one; naming the source keeps them apart.
 */
export function doorTaskId(source: string, taskId: string): string {
  return Buffer.from(JSON.stringify([source, taskId])).toString("base64url");
}

/** The (source, connector task id) a door task id names, or null for any other string. */
export function parseDoorTaskId(id: string): { source: string; taskId: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(id, "base64url").toString("utf-8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { source: parsed[0], taskId: parsed[1] };
    }
  } catch {
    // Not one of ours.
  }
  return null;
}

/** A 2025 `Task` in the 2026 wire's field names, under the door's id. */
function modernFields(source: string, task: Task): ModernTaskFields {
  return {
    taskId: doorTaskId(source, task.taskId),
    status: task.status,
    ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttl ?? null,
    ...(task.pollInterval !== undefined ? { pollIntervalMs: task.pollInterval } : {}),
  };
}

/** The flat task a `tools/call` answers when `source` started `task` for it. */
export function modernCreateTaskResult(source: string, task: Task): ModernCreateTaskResult {
  return { resultType: "task", ...modernFields(source, task) };
}

/** Where a task request resolves: the (workspace, identity) of the request, and its runtime's sources. */
export interface ModernTaskContext {
  workspaceId: string;
  identityId: string;
  /** The task-aware source by that name in the request's workspace, or null. */
  findSource(name: string): TaskAwareSource | null;
}

/** JSON-RPC error codes this file answers with. */
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;

interface TaskRequestBody {
  id: string | number;
  method: "tasks/get" | "tasks/cancel";
  params: { taskId?: unknown; _meta?: Record<string, unknown> };
}

/** The body when it is a `tasks/get` or `tasks/cancel` request; null for anything else. */
async function taskRequestBody(request: Request): Promise<TaskRequestBody | null> {
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as Partial<TaskRequestBody> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.method !== "tasks/get" && body.method !== "tasks/cancel") return null;
  if (typeof body.id !== "string" && typeof body.id !== "number") return null;
  return { id: body.id, method: body.method, params: body.params ?? {} };
}

/**
 * Answer a `tasks/get` or `tasks/cancel`, or null when
 * the request is anything else (the SDK serves it).
 *
 * The standard headers are checked as the SDK checks them for its own methods:
 * `MCP-Protocol-Version` names the envelope's version, `Mcp-Method` the
 * method, and `Mcp-Name` the task id.
 *
 * `scopeOf` reads the source a request names under `RESOURCE_SOURCE_META_KEY`,
 * as a scoped resource request does: it reaches only a task that source ran.
 * Another identity's task, another workspace's, another source's and one that
 * never existed all answer the same `-32602`.
 */
export async function answerModernTaskRequest(
  request: Request,
  ctx: ModernTaskContext | null,
  scopeOf: (meta: Record<string, unknown> | undefined) => TaskScope | undefined,
): Promise<Response | null> {
  const body = await taskRequestBody(request);
  if (!body) return null;
  const { id, method, params } = body;

  const mismatch = headerMismatch(request, method, params);
  if (mismatch)
    return jsonRpcResponse(400, { id, error: { code: HEADER_MISMATCH, message: mismatch } });

  const notFound = () =>
    jsonRpcResponse(200, {
      id,
      error: { code: INVALID_PARAMS, message: "Failed to retrieve task: Task not found" },
    });
  if (typeof params.taskId !== "string" || !ctx) return notFound();
  const named = parseDoorTaskId(params.taskId);
  if (!named) return notFound();
  const scope = scopeOf(params._meta);
  if (scope && scope.source !== named.source) return notFound();
  const source = ctx.findSource(named.source);
  if (!source) return notFound();

  const ownerContext = {
    workspaceId: ctx.workspaceId,
    identityId: ctx.identityId,
    originApp: named.source,
  };
  try {
    if (method === "tasks/cancel") {
      // An acknowledgement, and cooperative: a task already terminal stays as it is.
      await source.cancelTask(named.taskId, { ownerContext }).catch((err: unknown) => {
        if (!(err instanceof TaskAlreadyTerminalError)) throw err;
      });
      return jsonRpcResponse(200, { id, result: { resultType: "complete" } });
    }
    const task = await source.getTaskStatus(named.taskId, { ownerContext });
    const detail = isTerminal(task.status)
      ? await terminalDetail(source, named.taskId, ownerContext, task)
      : { status: task.status };
    return jsonRpcResponse(200, {
      id,
      result: { resultType: "complete", ...modernFields(named.source, task), ...detail },
    });
  } catch {
    // The connector forgot the task (TTL sweep), or it is not this caller's.
    return notFound();
  }
}

/**
 * A terminal task's inlined outcome. `failed` in SEP-2663 is a JSON-RPC error,
 * so a tool that answered — `isError` included — completed with that result;
 * only a task that produced no result at all failed.
 */
async function terminalDetail(
  source: TaskAwareSource,
  taskId: string,
  ownerContext: { workspaceId: string; identityId: string; originApp: string },
  task: Task,
): Promise<{
  status: Task["status"];
  result?: CallToolResult;
  error?: { code: number; message: string };
}> {
  if (task.status === "cancelled") return { status: "cancelled" };
  try {
    const result = (await source.awaitToolTaskResult(taskId, { ownerContext })) as CallToolResult;
    return { status: "completed", result };
  } catch (err) {
    // Swept between the status read and this one: gone, not failed.
    if (err instanceof TaskNotFoundError) throw err;
    return {
      status: "failed",
      error: { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function isTerminal(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Why the standard headers disagree with the body, or null when they agree. */
function headerMismatch(
  request: Request,
  method: string,
  params: TaskRequestBody["params"],
): string | null {
  const version = params._meta?.[PROTOCOL_VERSION_META_KEY];
  const pairs: Array<[string, unknown]> = [
    ["MCP-Protocol-Version", version],
    ["Mcp-Method", method],
    // A body with no string task id has no name to match; it is answered not found.
    ...(typeof params.taskId === "string"
      ? [["Mcp-Name", params.taskId] as [string, unknown]]
      : []),
  ];
  for (const [header, expected] of pairs) {
    const value = request.headers.get(header);
    if (value !== expected) {
      return `Bad Request: the ${header} header (${value ?? "missing"}) does not match the body`;
    }
  }
  return null;
}

function jsonRpcResponse(status: number, message: McpTaskAnswer): Response {
  return json<McpTaskAnswerBody>({ jsonrpc: "2.0", ...message }, status);
}
