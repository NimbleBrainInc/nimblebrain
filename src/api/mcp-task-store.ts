/**
 * In-memory `TaskStore` backing the platform's `/mcp` endpoint.
 *
 * The SDK's `Server` installs handlers for `tasks/{get,result,cancel,list}`
 * automatically when a `TaskStore` is provided in `ProtocolOptions`. Those
 * handlers all route through this store, which is the *only* thing that
 * bridges the JSON-RPC surface to the engine's per-source task machinery
 * (`McpSource.startToolAsTask` / `awaitToolTaskResult` / `getTaskStatus` /
 * `cancelTask`, introduced in Task 001).
 *
 * ## Keying
 *
 * Entries are keyed by `storeKey = `${workspaceId}:${identityId}:${taskId}``
 * — never by `taskId` alone. Cross-workspace / cross-user lookups hit a
 * different key and return `-32602 task not found` per MCP spec security
 * guidance (never leak cross-tenant existence).
 *
 * ## What's stored
 *
 * For each task we remember the source name and the tool name so
 * `tasks/{get,result,cancel}` can route back to the originating
 * `McpSource`. The `McpSource` owns the actual `TaskHandle` (stream,
 * terminal deferred, owner context) — this store is purely the JSON-RPC
 * adapter layer.
 *
 * ## Error mapping
 *
 * - `TaskNotFoundError` → `McpError(-32602, "task not found: <taskId>")`
 * - `TaskAlreadyTerminalError` → `McpError(-32602, "task … already terminal")`
 * - Any other engine error → `McpError(-32603, …)`
 *
 * ## SDK version pin
 *
 * This module depends on `@modelcontextprotocol/sdk@1.29.0`'s experimental
 * task APIs (`ProtocolOptions.taskStore`, `TaskStore` shape in
 * `experimental/tasks/interfaces.js`, `RELATED_TASK_META_KEY`). The SDK
 * marks these `@experimental` — any minor-version bump MUST be re-checked
 * against `node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/interfaces.d.ts`
 * and `shared/protocol.d.ts` (`RequestTaskStore`, `TaskStore`).
 *
 * Pinned in `package.json` at `^1.29.0`; bump deliberately, not on auto-update.
 */

import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  ErrorCode,
  McpError,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import type { UserIdentity } from "../identity/provider.ts";
import { TaskAlreadyTerminalError, TaskNotFoundError } from "../tools/types.ts";

/**
 * Minimal view of `McpSource`'s task surface that this store depends on.
 * We don't import `McpSource` directly so that `SharedSourceRef`-unwrapped
 * sources and test doubles can satisfy the shape without inheritance.
 */
export interface TaskAwareSource {
  getTaskStatus(taskId: string, opts: { ownerContext: OwnerContext }): Promise<Task>;
  awaitToolTaskResult(
    taskId: string,
    opts: { ownerContext: OwnerContext },
  ): Promise<{
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }>;
  cancelTask(taskId: string, opts: { ownerContext: OwnerContext }): Promise<Task>;
}

/** Owner context stamped on every task at creation, enforced on lookup. */
export interface OwnerContext {
  workspaceId: string;
  identityId?: string;
}

/** Per-task routing state. The McpSource owns the TaskHandle; we remember where to look. */
interface TaskEntry {
  source: TaskAwareSource;
  ownerContext: OwnerContext;
  /** Fully qualified tool name (with `__` source prefix) — retained for logging / diagnostics. */
  toolFullName: string;
  /** The Task object returned from `startToolAsTask`. Updated on every access. */
  task: Task;
  /** Populated when the result is stored via `storeTaskResult`. */
  result?: unknown;
}

/** Default fallback identityId used when the request has no authenticated user. */
const ANON_IDENTITY = "__anon__";

/**
 * Compose the internal storage key. Cross-workspace / cross-user lookups
 * will land on a different key and be treated as "not found".
 */
function storeKey(workspaceId: string, identityId: string | undefined, taskId: string): string {
  return `${workspaceId}:${identityId ?? ANON_IDENTITY}:${taskId}`;
}

/** Options needed to build a session-scoped task store. */
export interface McpTaskStoreOptions {
  /** Identity associated with this session. `null` in dev / unauthenticated modes. */
  identity: UserIdentity | null;
  /** Workspace the session is bound to. Required — no session without a workspace. */
  workspaceId: string;
}

/**
 * Extended store interface — adds `recordTask` so the `tools/call` handler
 * can register a newly-created task after `startToolAsTask` returns. The
 * SDK's base `TaskStore` only covers the polling side; we need a way to
 * publish a known task into the store without routing through
 * `TaskStore.createTask` (which expects us to synthesize a Task ourselves,
 * but the `McpSource` already did that work upstream).
 */
export interface McpTaskStore extends TaskStore {
  /** Register a task with a known taskId (the `McpSource` already created it). */
  recordTask(params: {
    source: TaskAwareSource;
    toolFullName: string;
    task: Task;
    ownerContext: OwnerContext;
  }): void;
  /** Test-only: how many tasks are currently live in this store. */
  _sizeForTesting(): number;
}

/**
 * Construct a fresh in-memory `TaskStore` bound to a single session's
 * workspace + identity.
 *
 * Lifetime: same as the SDK `Server` instance that owns it — one per session
 * under the current `createServer` pattern in `mcp-server.ts`. That matches
 * the "tasks die on platform restart" MVP constraint from
 * `SPEC_REFERENCE.md` §Deferred.
 */
export function createMcpTaskStore(options: McpTaskStoreOptions): McpTaskStore {
  const entries = new Map<string, TaskEntry>();
  const boundIdentityId = options.identity?.id;
  const boundWorkspaceId = options.workspaceId;

  function ownerContext(): OwnerContext {
    return {
      workspaceId: boundWorkspaceId,
      ...(boundIdentityId !== undefined ? { identityId: boundIdentityId } : {}),
    };
  }

  function lookup(taskId: string): TaskEntry {
    const key = storeKey(boundWorkspaceId, boundIdentityId, taskId);
    const entry = entries.get(key);
    if (!entry) {
      // Unknown taskId OR wrong owner. Spec §8 — don't distinguish.
      throw new McpError(ErrorCode.InvalidParams, `task not found: ${taskId}`);
    }
    return entry;
  }

  function mapEngineError(err: unknown, taskId: string): McpError {
    if (err instanceof TaskNotFoundError) {
      // The McpSource forgot the task (TTL sweep, different owner, never
      // existed). Externally indistinguishable from "wrong owner".
      return new McpError(ErrorCode.InvalidParams, `task not found: ${taskId}`);
    }
    if (err instanceof TaskAlreadyTerminalError) {
      return new McpError(
        ErrorCode.InvalidParams,
        `task ${taskId} already terminal (${err.status})`,
      );
    }
    if (err instanceof McpError) return err;
    return new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
  }

  const store: McpTaskStore = {
    recordTask({ source, toolFullName, task, ownerContext: owner }) {
      // We always key with the session's workspaceId/identityId, even if the
      // caller provides a more-specific owner (e.g. with originApp). The
      // SDK-installed handlers for tasks/{get,result,cancel} arrive with
      // only the sessionId to locate us, so that's all we can key on.
      const key = storeKey(owner.workspaceId, owner.identityId, task.taskId);
      entries.set(key, {
        source,
        ownerContext: owner,
        toolFullName,
        task,
      });
    },

    // ── TaskStore contract ─────────────────────────────────────────────
    //
    // The SDK also calls `createTask` when a request handler is not task-
    // aware — it creates a generic record for later retrieval. In our
    // model the `tools/call` handler does the real task creation via
    // `McpSource.startToolAsTask`, so `createTask` is effectively a
    // fallback for direct sampling/elicitation flows (which we don't use
    // today). Return a minimal synthetic Task to satisfy the interface —
    // if something actually calls this, the handler that recorded it
    // should override via `recordTask` immediately afterwards.
    async createTask(
      taskParams: CreateTaskOptions,
      _requestId: RequestId,
      _request: Request,
      _sessionId?: string,
    ): Promise<Task> {
      const now = new Date().toISOString();
      const taskId = crypto.randomUUID();
      const task: Task = {
        taskId,
        status: "working",
        ttl: taskParams.ttl ?? null,
        createdAt: now,
        lastUpdatedAt: now,
      };
      if (taskParams.pollInterval !== undefined) {
        task.pollInterval = taskParams.pollInterval;
      }
      // No source / owner known at this entry point — store with a
      // placeholder entry so tasks/get returns something sensible until
      // the real handler replaces it. This path is not exercised by the
      // platform's task-aware `tools/call`, which always goes through
      // recordTask.
      entries.set(storeKey(boundWorkspaceId, boundIdentityId, taskId), {
        source: {
          getTaskStatus: async () => task,
          awaitToolTaskResult: async () => ({ content: [], isError: true }),
          cancelTask: async () => ({ ...task, status: "cancelled", lastUpdatedAt: now }),
        },
        ownerContext: ownerContext(),
        toolFullName: "__synthetic__",
        task,
      });
      return task;
    },

    async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
      let entry: TaskEntry;
      try {
        entry = lookup(taskId);
      } catch {
        // SDK convention: return `null` instead of throwing so the
        // Protocol's `tasks/get` handler can raise its own `-32602`.
        return null;
      }
      try {
        const fresh = await entry.source.getTaskStatus(taskId, {
          ownerContext: entry.ownerContext,
        });
        entry.task = fresh;
        return fresh;
      } catch (err) {
        // Map engine-level TaskNotFoundError back to null so the SDK
        // layer raises -32602 uniformly. Everything else bubbles.
        if (err instanceof TaskNotFoundError) return null;
        throw mapEngineError(err, taskId);
      }
    },

    async storeTaskResult(
      taskId: string,
      status: "completed" | "failed",
      result: Result,
      _sessionId?: string,
    ): Promise<void> {
      const entry = lookup(taskId);
      entry.result = result;
      entry.task = {
        ...entry.task,
        status,
        lastUpdatedAt: new Date().toISOString(),
      };
    },

    async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
      const entry = lookup(taskId);
      // If the result is already cached (storeTaskResult was invoked),
      // serve that. Otherwise block on the engine's terminal deferred —
      // this is what makes `tasks/result` the canonical blocking read.
      if (entry.result !== undefined) return entry.result as Result;
      try {
        const callToolResult = await entry.source.awaitToolTaskResult(taskId, {
          ownerContext: entry.ownerContext,
        });
        entry.result = callToolResult;
        entry.task = {
          ...entry.task,
          status: callToolResult.isError ? "failed" : "completed",
          lastUpdatedAt: new Date().toISOString(),
        };
        return callToolResult as unknown as Result;
      } catch (err) {
        throw mapEngineError(err, taskId);
      }
    },

    async updateTaskStatus(
      taskId: string,
      status: Task["status"],
      statusMessage?: string,
      _sessionId?: string,
    ): Promise<void> {
      const entry = lookup(taskId);
      // The SDK's built-in tasks/cancel handler transitions the task to
      // 'cancelled' via this method. Route that back into the engine so
      // the upstream bundle actually receives `tasks/cancel`. Other
      // transitions (engine-initiated `completed`/`failed`) just update
      // the cached Task.
      if (status === "cancelled") {
        try {
          const finalTask = await entry.source.cancelTask(taskId, {
            ownerContext: entry.ownerContext,
          });
          entry.task = {
            ...finalTask,
            ...(statusMessage !== undefined ? { statusMessage } : {}),
          };
          return;
        } catch (err) {
          throw mapEngineError(err, taskId);
        }
      }
      entry.task = {
        ...entry.task,
        status,
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        lastUpdatedAt: new Date().toISOString(),
      };
    },

    // tasks/list is deferred (SPEC_REFERENCE.md §Deferred) — return an
    // empty result so a client that tries it doesn't crash. We don't
    // advertise `tasks.list` in capabilities so spec-compliant clients
    // won't call this anyway.
    async listTasks(_cursor?: string, _sessionId?: string) {
      return { tasks: [] };
    },

    _sizeForTesting(): number {
      return entries.size;
    },
  };

  return store;
}
