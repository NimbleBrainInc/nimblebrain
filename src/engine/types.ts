import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { ContentBlock, TextContent } from "@modelcontextprotocol/sdk/types.js";

export type { ContentBlock, TextContent };

/** Port 2: Tool routing abstraction. */
export interface ToolRouter {
  availableTools(): Promise<ToolSchema[]>;
  /**
   * Execute a tool call. The optional `signal` propagates run-scoped
   * cancellation from the engine down to the tool implementation. For
   * task-augmented MCP tools it becomes `tasks/cancel`; for inline tools
   * it's an `AbortSignal` forwarded on the request.
   */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (_meta). Includes UI metadata like resourceUri. */
  annotations?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

/** Port 3: Observability event sink. */
export interface EventSink {
  emit(event: EngineEvent): void;
}

export type EngineEventType =
  | "chat.start"
  | "run.start"
  | "text.delta"
  | "tool.start"
  | "tool.done"
  | "tool.progress"
  | "llm.done"
  | "run.done"
  | "run.error"
  | "bundle.installed"
  | "bundle.uninstalled"
  | "bundle.crashed"
  | "bundle.recovered"
  | "bundle.dead"
  | "data.changed"
  | "config.changed"
  | "skill.created"
  | "skill.updated"
  | "skill.deleted"
  | "file.created"
  | "file.deleted"
  | "bridge.tool.call"
  | "bridge.tool.done"
  | "http.error"
  | "audit.auth_failure"
  | "audit.permission_denied";

export interface EngineEvent {
  type: EngineEventType;
  data: Record<string, unknown>;
}

/** Hooks for intercepting the engine loop at 4 strategic points. */
export interface EngineHooks {
  /** Modify messages before LLM call (e.g., windowing, context injection). */
  transformContext?: (messages: LanguageModelV3Message[]) => LanguageModelV3Message[];

  /** Gate or modify tool calls before execution. Return null to skip the tool. */
  beforeToolCall?: (call: ToolCall) => ToolCall | null | Promise<ToolCall | null>;

  /** Modify or log tool results after execution. */
  afterToolCall?: (call: ToolCall, result: ToolResult) => ToolResult | Promise<ToolResult>;

  /** Transform system prompt before LLM call. */
  transformPrompt?: (prompt: string) => string;
}

/** Engine configuration per run. */
export interface EngineConfig {
  model: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  hooks?: EngineHooks;
  /**
   * AbortSignal for run cancellation.
   *
   * Propagated down through `ToolRouter.execute(call, signal)` to the
   * underlying tool source. For task-augmented MCP tools this becomes
   * `tasks/cancel` on the server; for inline tools the SDK aborts the
   * in-flight RPC. Long-running tools MUST honor this signal — see the
   * "Long-Running Tools (MCP Tasks)" section in CLAUDE.md for the contract.
   */
  signal?: AbortSignal;
  /**
   * Maximum char size of a single tool result's ContentBlock[].
   * Results exceeding this are replaced with an isError summary before
   * event emission, hooks, or history accumulation.
   * Set to 0 to disable. Defaults to 1_000_000 (1M chars).
   */
  maxToolResultSize?: number;
}

/**
 * Per-LLM-call finish reason (mirrors AI SDK V3 `LanguageModelV3FinishReason.unified`).
 * Persisted on `llm.response` events so post-hoc analysis can tell a clean
 * stop from a length-truncated turn from a content-filter rejection.
 */
export type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

/**
 * Run-level stop reason. Derived from the agent loop's exit condition
 * combined with the final LLM call's finish reason:
 *
 *   - `complete`         — model said done (finish=stop) with no pending tools
 *   - `max_iterations`   — agent loop hit its iteration cap
 *   - `length`           — last LLM call hit `maxOutputTokens` mid-turn
 *   - `content_filter`   — last LLM call was blocked by provider moderation
 *   - `error`            — last LLM call's finish reason was `error`
 *   - `other`            — anything else (provider returned `other` / `unknown`)
 *
 * `error` here is the *finish-reason* error category, not a thrown engine
 * error — the latter still emits `run.error` instead.
 */
export type StopReason =
  | "complete"
  | "max_iterations"
  | "length"
  | "content_filter"
  | "error"
  | "other";

/** Result returned from a single engine run. */
export interface EngineResult {
  output: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: StopReason;
  /** Final LLM call's finish reason. Useful for diagnosing why the loop ended. */
  finishReason?: FinishReason;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  ms: number;
  resourceUri?: string;
  /**
   * MCP `resource_link` content blocks surfaced by the tool result.
   * Distinct from `resourceUri`: this is a per-call, spec-defined pointer
   * to resources the client should fetch via `resources/read`.
   */
  resourceLinks?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    description?: string;
  }>;
}
