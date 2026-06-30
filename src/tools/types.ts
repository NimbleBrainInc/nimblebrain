import type { ToolResult } from "../engine/types.ts";

/** A tool with source tracking. Extends ToolSchema with a source field. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: string; // "mcpb:leadgen" | "connector:slack" | "inline"
  /** MCP tool annotations (_meta). Includes UI metadata like resourceUri. */
  annotations?: Record<string, unknown>;
  /**
   * Tool-level execution metadata from the MCP spec (draft 2025-11-25).
   *
   * `taskSupport` controls task-augmentation for this tool:
   *   - `"optional"` — tool can run inline OR as a task (client decides)
   *   - `"required"` — tool MUST be invoked with task augmentation
   *   - `"forbidden"` — tool MUST NOT be invoked as a task
   *   - (absent / undefined) — same as `"forbidden"` (default)
   *
   * When a tool declares `"optional"` or `"required"`, the client (this engine)
   * attaches `params.task: { ttl }` to outbound `tools/call` so the server
   * returns a CreateTaskResult immediately instead of blocking. The engine
   * then polls via `tasks/get` and retrieves via `tasks/result`.
   */
  execution?: {
    taskSupport?: "optional" | "required" | "forbidden";
  };
}

/** Pluggable tool provider. Each source manages its own lifecycle. */
export interface ToolSource {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  tools(): Promise<Tool[]>;
  /**
   * Execute a tool by its bare name (the `<source>__` prefix is stripped by
   * `ToolRegistry` before dispatch). The optional `signal` propagates
   * run-scoped cancellation — MCP sources forward it into the protocol
   * (tasks/cancel for task-augmented calls, RequestOptions for inline);
   * other sources may ignore it if their work is fast.
   *
   * Identity context flows through `runWithRequestContext`'s
   * AsyncLocalStorage; sources that need the caller's identity read it
   * there. No principal argument is threaded through.
   */
  execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  /**
   * Subscribe to "my tool list may have changed" signals — fired when the
   * source's enumerable tool set transitions (a subprocess (re)connects after
   * a crash/slow boot, a deferred/pending-auth start completes, or the server
   * pushes a native `notifications/tools/list_changed`). Returns an
   * unsubscribe function.
   *
   * Optional: only async sources whose tool set materializes AFTER
   * construction implement it. The contract exists so callers that memoize a
   * projection of the tool list (e.g. the cross-workspace tool-list
   * aggregator) can invalidate reactively instead of polling — a source
   * becoming reachable is NOT a workspace-config change, so it can't be caught
   * by watching `workspace.json`. `ToolRegistry` is the single consumer; it
   * bridges this per-source signal to its own invalidation listener.
   */
  subscribeToolsChanged?(listener: () => void): () => void;
}

export type { ToolResult } from "../engine/types.ts";

/** Structured resource content returned by MCP resource reads. */
export interface ResourceData {
  text?: string;
  blob?: Uint8Array;
  mimeType?: string;
  /**
   * Per-content `_meta` from the MCP resource. Passed through to host-side
   * consumers so spec-defined fields like `_meta.ui.csp`, `_meta.ui.permissions`,
   * `_meta.ui.prefersBorder`, and `_meta.ui.domain` (ext-apps `io.modelcontextprotocol/ui`
   * extension) reach the iframe bridge and actually apply.
   *
   * Shape is intentionally open (`Record<string, unknown>`) because the MCP spec
   * defines `_meta` as a free-form namespace; consumers typecheck specific
   * fields at their point of use.
   */
  meta?: Record<string, unknown>;
}

/**
 * Authorization context bound to a task at creation time.
 *
 * Every per-task operation (`getTaskStatus`, `awaitToolTaskResult`,
 * `cancelTask`) checks the caller-supplied `TaskOwnerContext` against the one
 * stamped at `startToolAsTask` time. A mismatch surfaces as a
 * `TaskNotFoundError` — we deliberately do NOT distinguish "wrong owner" from
 * "no such task" to avoid leaking task-existence to unauthorized callers.
 *
 * Required: `workspaceId`. Optional: `identityId` (user) and `originApp`
 * (the app / iframe that initiated the call). When set on the stamped context,
 * subsequent lookups MUST supply matching values.
 */
export interface TaskOwnerContext {
  workspaceId: string;
  identityId?: string;
  originApp?: string;
}

/**
 * Error thrown by the task lookup surface when a task isn't found OR the
 * caller's `TaskOwnerContext` doesn't match the one stamped at creation.
 *
 * Unified on purpose: we don't want to leak task existence to callers who
 * don't own the task. The `/mcp` layer maps this to JSON-RPC `-32602` per
 * MCP tasks spec (draft 2025-11-25).
 */
export class TaskNotFoundError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

/**
 * Error thrown when a caller tries to cancel a task that has already reached
 * a terminal state (`completed` / `failed` / `cancelled`).
 *
 * The `/mcp` layer maps this to JSON-RPC `-32602` per MCP tasks spec.
 */
export class TaskAlreadyTerminalError extends Error {
  readonly taskId: string;
  readonly status: string;
  constructor(taskId: string, status: string) {
    super(`task ${taskId} is already terminal (${status})`);
    this.name = "TaskAlreadyTerminalError";
    this.taskId = taskId;
    this.status = status;
  }
}
