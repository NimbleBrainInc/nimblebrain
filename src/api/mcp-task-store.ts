/**
 * In-memory `TaskStore` backing the platform's `/mcp` endpoint.
 *
 * Passing a `TaskStore` in `ProtocolOptions` makes the SDK's `Server` install
 * handlers for `tasks/{get,result,cancel,list}`. `/mcp` replaces the first
 * three with its own (`registerTaskHandlers` in `mcp-server.ts`), because the
 * SDK's pass only `(taskId, sessionId)` and a request's scope has to reach the
 * lookup. Every handler routes through this store, which is the *only* thing
 * that bridges the JSON-RPC surface to the engine's per-source task machinery
 * (`McpSource.startToolAsTask` / `awaitToolTaskResult` / `getTaskStatus` /
 * `cancelTask`, introduced in Task 001).
 *
 * ## Keying
 *
 * Entries are keyed by `storeKey = `${identityId}:${taskId}``, and under that
 * by the workspace and source that ran the task (`ownerContext.workspaceId`,
 * `ownerContext.originApp`). A connector's own server mints the task id, so two
 * sources can mint the same one, and each keeps its own entry. A `/mcp`
 * session is bound to one workspace, so its tasks all ran there; the
 * `ownerContext` is still stamped on each entry — the underlying
 * `McpSource.getTaskStatus` / `awaitToolTaskResult` / `cancelTask` paths still
 * authorize per-task by exact (workspaceId, identityId, taskId) match.
 * Cross-user lookups hit a different key and return `-32602 task not found`
 * per MCP spec security guidance (never leak cross-tenant existence).
 *
 * ## Scope
 *
 * A lookup may carry a `TaskScope`: the one source the request is for, in the
 * workspace the request is bound to. The iframe bridge names the app's server
 * this way, because every iframe shares one `/mcp` session. A source name
 * names a server only within a workspace, so a scoped lookup finds only the
 * task that source ran in that workspace; any other task answers `-32602 task
 * not found`, the same as one that does not exist. An unscoped lookup (an MCP
 * client that names no source) finds the task most recently recorded under
 * that id.
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
import {
  TaskAlreadyTerminalError,
  TaskNotFoundError,
  type TaskOwnerContext,
} from "../tools/types.ts";

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
export type OwnerContext = TaskOwnerContext;

/** The one source a task request is for, in the workspace the request is bound to. See "Scope" above. */
export interface TaskScope {
  source: string;
  /** The request's validated workspace. None reaches no workspace's task. */
  workspaceId: string | undefined;
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
 * Compose the internal storage key. Cross-user lookups land on a different
 * key and are treated as "not found". The (workspaceId, identityId, taskId)
 * trio is still enforced downstream by `McpSource`'s `ownerContext` check;
 * the session-level key omits `workspaceId`: the entry beneath it records the
 * workspace that ran the task.
 */
function storeKey(identityId: string | undefined, taskId: string): string {
  return `${identityId ?? ANON_IDENTITY}:${taskId}`;
}

/** The key of one task id's entry for the workspace and source that ran it. */
function ownerKey(workspaceId: string | undefined, source: string | undefined): string {
  return JSON.stringify([workspaceId ?? null, source ?? null]);
}

/** Options needed to build a session-scoped task store. */
export interface McpTaskStoreOptions {
  /** Identity associated with this session. `null` in dev / unauthenticated modes. */
  identity: UserIdentity | null;
}

/**
 * Extended store interface — adds `recordTask` so the `tools/call` handler
 * can register a newly-created task after `startToolAsTask` returns. The
 * SDK's base `TaskStore` only covers the polling side; we need a way to
 * publish a known task into the store without routing through
 * `TaskStore.createTask` (which expects us to synthesize a Task ourselves,
 * but the `McpSource` already did that work upstream).
 *
 * `getTask`, `getTaskResult` and `updateTaskStatus` take an optional trailing
 * `scope`. See "Scope" above.
 */
export interface McpTaskStore extends TaskStore {
  /** Register a task with a known taskId (the `McpSource` already created it). */
  recordTask(params: {
    source: TaskAwareSource;
    toolFullName: string;
    task: Task;
    ownerContext: OwnerContext;
  }): void;
  getTask(taskId: string, sessionId?: string, scope?: TaskScope): Promise<Task | null>;
  getTaskResult(taskId: string, sessionId?: string, scope?: TaskScope): Promise<Result>;
  updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string,
    scope?: TaskScope,
  ): Promise<void>;
  /** Test-only: how many tasks are currently live in this store. */
  _sizeForTesting(): number;
}

/**
 * Construct a fresh in-memory `TaskStore` bound to a single session's
 * workspace + identity.
 *
 * Lifetime: same as the SDK `Server` instance that owns it — one per session
 * under the current `createServer` pattern in `mcp-server.ts`. That matches
 * the "tasks die on platform restart" MVP constraint.
 */
export function createMcpTaskStore(options: McpTaskStoreOptions): McpTaskStore {
  // `storeKey` → `ownerKey` (the workspace and source that ran the task) → its
  // entry. One task id's entries are in the order they were recorded; an
  // unscoped lookup reads the last.
  const entries = new Map<string, Map<string, TaskEntry>>();
  const boundIdentityId = options.identity?.id;

  function lookup(taskId: string, scope?: TaskScope): TaskEntry {
    const byOwner = entries.get(storeKey(boundIdentityId, taskId));
    const entry =
      scope === undefined
        ? [...(byOwner?.values() ?? [])].at(-1)
        : byOwner?.get(ownerKey(scope.workspaceId, scope.source));
    if (!entry) {
      // Unknown taskId, wrong owner, OR another workspace's or source's task.
      // Spec §8 — don't distinguish.
      throw new McpError(ErrorCode.InvalidParams, `task not found: ${taskId}`);
    }
    return entry;
  }

  function put(taskId: string, entry: TaskEntry): void {
    const key = storeKey(boundIdentityId, taskId);
    const byOwner = entries.get(key) ?? new Map<string, TaskEntry>();
    // A task with no source (the synthetic `createTask` below) is out of every
    // scope's reach: a scope always names a source.
    const owner = ownerKey(entry.ownerContext.workspaceId, entry.ownerContext.originApp);
    // Delete first so a re-recorded task moves last, where an unscoped lookup reads.
    byOwner.delete(owner);
    byOwner.set(owner, entry);
    entries.set(key, byOwner);
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
      // We key by (sessionIdentityId, taskId), then by the workspace and source
      // that ran it. The owner
      // context is preserved on the entry so the McpSource's per-task
      // authorization check still fires.
      put(task.taskId, {
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
    // today). Return a minimal synthetic Task to satisfy the interface.
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
      // No source / owner known at this entry point — store a placeholder
      // entry so an unscoped tasks/get returns something sensible. This path
      // is not exercised by the platform's task-aware `tools/call`, which
      // always goes through recordTask. Workspace and source are unknown here
      // (the entry point predates any per-call routing), so the placeholder
      // owner context carries neither, and no scoped request can reach it.
      put(taskId, {
        source: {
          getTaskStatus: async () => task,
          awaitToolTaskResult: async () => ({ content: [], isError: true }),
          cancelTask: async () => ({ ...task, status: "cancelled", lastUpdatedAt: now }),
        },
        ownerContext: {
          workspaceId: "",
          ...(boundIdentityId !== undefined ? { identityId: boundIdentityId } : {}),
        },
        toolFullName: "__synthetic__",
        task,
      });
      return task;
    },

    async getTask(taskId: string, _sessionId?: string, scope?: TaskScope): Promise<Task | null> {
      let entry: TaskEntry;
      try {
        entry = lookup(taskId, scope);
      } catch {
        // SDK convention: return `null` instead of throwing so the
        // `tasks/get` handler can raise its own `-32602`.
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

    async getTaskResult(taskId: string, _sessionId?: string, scope?: TaskScope): Promise<Result> {
      const entry = lookup(taskId, scope);
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
      scope?: TaskScope,
    ): Promise<void> {
      const entry = lookup(taskId, scope);
      // The tasks/cancel handler transitions the task to 'cancelled' via this
      // method. Route that back into the engine so the upstream connector
      // actually receives `tasks/cancel`. Other transitions (engine-initiated
      // `completed`/`failed`) just update the cached Task.
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

    // tasks/list is deferred — return an
    // empty result so a client that tries it doesn't crash. We don't
    // advertise `tasks.list` in capabilities so spec-compliant clients
    // won't call this anyway.
    async listTasks(_cursor?: string, _sessionId?: string) {
      return { tasks: [] };
    },

    _sizeForTesting(): number {
      let size = 0;
      for (const byOwner of entries.values()) size += byOwner.size;
      return size;
    },
  };

  return store;
}
