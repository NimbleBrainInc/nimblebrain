import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { ContentBlock, TextContent } from "@modelcontextprotocol/sdk/types.js";

export type { ContentBlock, TextContent };

/** Port 2: Tool routing abstraction. */
export interface ToolRouter {
  availableTools(): Promise<ToolSchema[]>;
  execute(call: ToolCall): Promise<ToolResult>;
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
  /**
   * When an MCP server returns a CreateTaskResult instead of an immediate
   * result, the raw task metadata is attached here. The engine detects this
   * and starts the polling loop. See PRODUCT_SPEC.md §13.
   */
  _taskResult?: {
    task: {
      taskId: string;
      status: string;
      ttl: number | null;
      createdAt: string;
      lastUpdatedAt: string;
      pollInterval?: number;
      statusMessage?: string;
    };
    _meta?: Record<string, unknown>;
  };
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
  | "task.input_required"
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
   * When aborted, active MCP tasks receive tasks/cancel. See §13.
   */
  signal?: AbortSignal;
  /**
   * Resolver for MCP task clients.
   * Given a tool call ID, returns a TaskClient if the source supports
   * task-augmented execution, or undefined for sync-only sources.
   * The engine uses this to poll tasks and send cancellations.
   */
  taskClientResolver?: TaskClientResolver;
  /**
   * Maximum time in milliseconds to wait for a single task poll to complete.
   * If pollTask() does not resolve within this window the engine returns an
   * isError result and continues the agentic loop — it does NOT hang or throw.
   * Defaults to 120_000 (2 minutes).
   */
  taskTimeoutMs?: number;
  /**
   * Maximum char size of a single tool result's ContentBlock[].
   * Results exceeding this are replaced with an isError summary before
   * event emission, hooks, or history accumulation.
   * Set to 0 to disable. Defaults to 1_000_000 (1M chars).
   */
  maxToolResultSize?: number;
}

/** Resolves a TaskClient for a given tool call, or undefined if unavailable. */
export type TaskClientResolver = (toolName: string) => TaskClientPort | undefined;

/**
 * Minimal interface for MCP task operations needed by the engine.
 * Decoupled from the concrete MCP Client for testability.
 */
export interface TaskClientPort {
  getTask(taskId: string): Promise<{
    taskId: string;
    status: string;
    ttl: number | null;
    createdAt: string;
    lastUpdatedAt: string;
    pollInterval?: number;
    statusMessage?: string;
  }>;
  getTaskResult(taskId: string): Promise<{
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }>;
  cancelTask(taskId: string): Promise<unknown>;
}

/** Result returned from a single engine run. */
export interface EngineResult {
  output: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: "complete" | "max_iterations";
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  ms: number;
  resourceUri?: string;
}
