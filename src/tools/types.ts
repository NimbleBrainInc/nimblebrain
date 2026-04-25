import type { ToolResult } from "../engine/types.ts";

/** A tool with source tracking. Extends ToolSchema with a source field. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: string; // "mcpb:leadgen" | "upjack:crm" | "inline"
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
   */
  execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
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
