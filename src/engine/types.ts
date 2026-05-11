import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { ContentBlock, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { TokenUsage } from "../usage/types.ts";

export type { ContentBlock, TextContent };

/** Port 2: Tool routing abstraction. */
export interface ToolRouter {
  availableTools(): Promise<ToolSchema[]>;
  /**
   * Execute a tool call. The optional `signal` propagates run-scoped
   * cancellation from the engine down to the tool implementation. For
   * task-augmented MCP tools it becomes `tasks/cancel`; for inline tools
   * it's an `AbortSignal` forwarded on the request.
   *
   * `principalId` is the identity to authenticate as for member-scoped
   * remote MCP bundles — the conversation owner's user id for agent-loop
   * calls, the explicit caller for the REST `/v1/tools/call` path. Single-
   * principal sources ignore it; only `UserPoolSource` reads it.
   */
  execute(call: ToolCall, signal?: AbortSignal, principalId?: string): Promise<ToolResult>;
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

export interface ToolPromotionResult {
  ok: boolean;
  toolName: string;
  changed: boolean;
  message: string;
  reason?: string;
}

export interface ToolPromotionControls {
  addTool(toolName: string): ToolPromotionResult;
  removeTool(toolName: string): ToolPromotionResult;
}

/** Port 3: Observability event sink. */
export interface EventSink {
  emit(event: EngineEvent): void;
}

export type EngineEventType =
  | "chat.start"
  | "run.start"
  | "text.delta"
  | "reasoning.delta"
  | "tool.preparing"
  | "tool.preparing.done"
  | "tool.start"
  | "tool.done"
  | "tool.progress"
  | "tool.promoted"
  | "tool.released"
  | "llm.done"
  | "run.done"
  | "run.error"
  | "skills.loaded"
  | "context.assembled"
  | "bundle.installed"
  | "bundle.uninstalled"
  | "bundle.crashed"
  | "bundle.recovered"
  | "bundle.dead"
  /**
   * Per-principal connection state change for a remote URL bundle.
   * Payload: { wsId, serverName, principalId, state, authorizationUrl? }.
   * Workspace-scoped bundles emit one event stream (principalId = "_workspace");
   * member-scoped bundles emit one stream per active member.
   */
  | "connection.state_changed"
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

/**
 * Generic event envelope. Per-event-type payload schemas are declared in
 * `./schemas/events.ts` (TypeBox + `Static<typeof X>` types). Code that
 * needs the precise payload shape can import the typed payload directly
 * (`SkillsLoadedPayload`, `DataChangedPayload`, etc.) and narrow on
 * `event.type` before access. Tightening `data` here to a discriminated
 * union over those payloads is a follow-up — it requires auditing every
 * consumer to add the corresponding `event.type === "..."` narrowing.
 */
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

/**
 * Provider-neutral extended-thinking config. The engine translates this
 * to per-provider options at call time:
 *   - Anthropic — `providerOptions.anthropic.thinking.{type,budgetTokens?}`
 *   - OpenAI o-series — `providerOptions.openai.reasoningEffort` (TODO)
 *   - Google Gemini 2.5 — `providerOptions.google.thinkingConfig` (TODO)
 *   - Any other provider — ignored
 *
 * Resolution priority is handled upstream (see resolveThinking in
 * src/runtime/resolve-thinking.ts); the engine receives an already-
 * resolved value or `undefined` for "let the provider default decide".
 */
export interface ResolvedThinking {
  mode: "off" | "adaptive" | "enabled";
  /** Token budget for `enabled`. Ignored for `off`/`adaptive`. */
  budgetTokens?: number;
}

/** Engine configuration per run. */
export interface EngineConfig {
  model: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /**
   * Resolved thinking option for this call. Optional; absent means the
   * engine doesn't request thinking (provider default behavior).
   */
  thinking?: ResolvedThinking;
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
  /**
   * Pre-computed run-scope telemetry the runtime hands to the engine so the
   * engine can emit it tied to the same `runId` as `run.start`. The engine
   * fires these immediately after `run.start` and before the first LLM call,
   * so the conversation log records what the prompt looked like.
   *
   * Phase 2: `skills.loaded` and `context.assembled` payloads. Future phases
   * may add more entries here without touching the engine signature.
   */
  runMetadata?: RunMetadata;
  /**
   * Identity to authenticate as for member-scoped MCP bundles invoked
   * during this run. Set by the runtime to the conversation owner's
   * user id (the agent-loop identity rule). When undefined, member-scoped
   * tool calls return a structured `pending_auth`-style error instead of
   * silently using someone else's tokens. Workspace-scoped sources ignore
   * this entirely.
   */
  principalId?: string;
  toolPromotion?: {
    isToolEligible(tool: ToolSchema): boolean;
    registerControls(controls: ToolPromotionControls): () => void;
  };
}

/**
 * Pre-emit telemetry attached to an engine run. The runtime computes this
 * before calling `engine.run()`; the engine emits matching events after
 * `run.start`. Shared between `EngineConfig` and the runtime helpers
 * (`buildSkillsLoadedPayload` / `buildContextAssembledPayload`) so any
 * shape drift is a type error rather than silent disagreement.
 */
export interface RunMetadata {
  skillsLoaded?: SkillsLoadedPayload;
  contextAssembled?: ContextAssembledPayload;
}

export interface SkillsLoadedPayload {
  skills: SkillsLoadedEntry[];
  totalTokens: number;
}

export interface ContextAssembledPayload {
  sources: ContextAssembledSource[];
  excluded: ContextAssembledSource[];
  totalTokens: number;
  modelMaxContext?: number;
  headroomTokens?: number;
}

/**
 * Per-skill telemetry attached to a `skills.loaded` event. Re-exported
 * from `src/conversation/types.ts` so emitters and persisters reference
 * one definition; drift surfaces as a type error.
 *
 * `contentHash` is the SHA-256 (hex) of the skill body that was composed
 * into the prompt. Lets debug tools detect mutation between when the
 * skill loaded and when an operator inspects it:
 *   - hash matches current source → display body verbatim, full fidelity
 *   - hash differs → look up against `_versions/` snapshots to find the
 *     body that actually loaded, or surface a "this skill changed since"
 *     warning if no matching snapshot exists.
 *
 * Cheap (~64 bytes per skill per turn); decoupled from the body itself
 * so event size stays bounded.
 */
export interface SkillsLoadedEntry {
  id: string;
  layer: 3;
  scope: "org" | "workspace" | "user" | "bundle";
  version: string;
  tokens: number;
  /** SHA-256 hex of the skill body composed into the prompt. */
  contentHash: string;
  loadedBy: "always" | "tool_affinity";
  reason: string;
}

/**
 * One entry in `context.assembled.sources` / `excluded`. Required `tokens`
 * + free-form discriminators (`count`, `version`, `turns`, etc.) per source
 * kind. Tightening the engine payload to this shape (vs `Record<string,
 * unknown>`) prevents emitters from accidentally shipping rows without a
 * token count.
 */
export interface ContextAssembledSource {
  kind: string;
  count?: number;
  tokens: number;
  toolSetHash?: string;
  version?: string | number;
  userId?: string;
  turns?: number;
  compacted?: boolean;
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
 *
 * Note the casing asymmetry vs `FinishReason`: the V3 spec uses
 * kebab-case (`content-filter`, `tool-calls`); our run-level union uses
 * snake_case to match the legacy `max_iterations` value already in
 * persisted JSONL. They're related but not identical — see
 * `deriveStopReason()` in engine.ts for the mapping.
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
  /** Cumulative token usage across all LLM calls in this run. */
  usage: TokenUsage;
  /** Cumulative LLM latency across all calls in this run. */
  llmMs: number;
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
