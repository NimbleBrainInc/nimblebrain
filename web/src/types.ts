/** UI metadata for a bundle (sidebar entry, icon). */
export interface BundleUiMeta {
  name: string;
  icon: string;
}

/** Bundle lifecycle states. */
export type BundleState =
  | "starting"
  | "running"
  | "crashed"
  | "dead"
  | "stopped"
  | "pending_auth";

/** App info returned by GET /v1/apps. */
export interface AppInfo {
  name: string;
  bundleName: string;
  version: string;
  status: BundleState;
  type: "upjack" | "plain";
  toolCount: number;
  trustScore: number;
  ui: BundleUiMeta | null;
}

/** Tool call result from POST /v1/tools/call. */
export interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

/** Tool call record in a chat result. */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  ms: number;
  resourceUri?: string;
  resourceLinks?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    description?: string;
  }>;
}

/** Context identifying the app/server the user is interacting with. */
export interface AppContext {
  appName: string;
  serverName: string;
  /** UI state pushed by the app via Synapse setVisibleState(). */
  appState?: {
    state: Record<string, unknown>;
    summary?: string;
    updatedAt: string;
  };
}

/** Chat request body for POST /v1/chat and POST /v1/chat/stream. */
export interface ChatRequest {
  message: string;
  conversationId?: string;
  model?: string;
  maxIterations?: number;
  appContext?: AppContext;
}

/**
 * Token usage for a single chat turn — the wire shape returned by
 * `POST /v1/chat` and the SSE `done` event. Mirrors `TurnUsage` from
 * the runtime (`src/runtime/types.ts`) plus `costUsd` which the API
 * boundary computes from `(model, usage)`. Cache and reasoning fields
 * are optional per the canonical `TokenUsage` shape.
 */
export interface TurnUsage extends UsageShape {
  model: string;
  llmMs: number;
  iterations: number;
  /** Computed at the API boundary from (model, usage). Always present. */
  costUsd: number;
}

/** Full chat result from POST /v1/chat and the final SSE "done" event. */
export interface ChatResult {
  response: string;
  conversationId: string;
  skillName: string | null;
  toolCalls: ToolCallRecord[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  usage?: TurnUsage;
}

/** Health check response from GET /v1/health. */
export interface HealthInfo {
  status: string;
  version: string;
  buildSha: string | null;
  uptime: number;
  bundles: Array<{ name: string; state: BundleState }>;
}

// --- SSE Event Types ---

export interface BundleInstalledEvent {
  name: string;
  bundleName: string;
  status: BundleState;
  ui: BundleUiMeta | null;
}

export interface BundleUninstalledEvent {
  name: string;
}

export interface BundleCrashedEvent {
  name: string;
  restartAttempt: number;
}

export interface BundleRecoveredEvent {
  name: string;
}

export interface BundleDeadEvent {
  name: string;
  message: string;
}

export interface ConnectionStateChangedEvent {
  wsId: string;
  serverName: string;
  bundleName: string;
  principalId: string;
  state: BundleState;
  /** Populated only when state === "pending_auth". */
  authorizationUrl?: string;
  /** Populated when state === "dead" or "crashed". */
  lastError?: string;
}

export interface DataChangedEvent {
  server: string;
  tool: string;
  timestamp: string;
}

export interface HeartbeatEvent {
  timestamp: string;
}

export interface ConfigChangedEvent {
  fields?: string[];
  timestamp: string;
}

/** SSE event type to payload mapping. */
export interface SseEventMap {
  "bundle.installed": BundleInstalledEvent;
  "bundle.uninstalled": BundleUninstalledEvent;
  "bundle.crashed": BundleCrashedEvent;
  "bundle.recovered": BundleRecoveredEvent;
  "bundle.dead": BundleDeadEvent;
  "connection.state_changed": ConnectionStateChangedEvent;
  "data.changed": DataChangedEvent;
  "config.changed": ConfigChangedEvent;
  heartbeat: HeartbeatEvent;
}

/** Union of all SSE event type strings. */
export type SseEventType = keyof SseEventMap;

// --- Chat Stream SSE Events ---

export interface TextDeltaEvent {
  runId: string;
  text: string;
}

/**
 * Streaming reasoning (extended-thinking) delta. Same shape as
 * `TextDeltaEvent` — handled symmetrically in `useChat`. Only fires
 * when the model emits reasoning content (Anthropic with
 * `providerOptions.anthropic.thinking` enabled, or any model that
 * produces reasoning by default).
 */
export interface ReasoningDeltaEvent {
  runId: string;
  text: string;
}

export interface ToolStartEvent {
  runId: string;
  name: string;
  id: string;
  resourceUri?: string;
  input?: Record<string, unknown>;
}

/**
 * Fired when the model begins emitting a tool-call block, before the
 * tool actually executes. Bridges the dark gap between the last text
 * delta and `tool.start` when the model is streaming a large tool
 * input (e.g. a 45 KB document body) — without this, the UI has no
 * signal during that window.
 */
export interface ToolPreparingEvent {
  runId: string;
  id: string;
  name: string;
}

export interface ToolPreparingDoneEvent {
  runId: string;
  id: string;
}

export interface ResourceLinkInfo {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface ToolDoneEvent {
  runId: string;
  name: string;
  id: string;
  ok: boolean;
  ms: number;
  resourceUri?: string;
  /** MCP `resource_link` blocks surfaced by the tool result, if any. */
  resourceLinks?: ResourceLinkInfo[];
  result?: {
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  };
}

export interface StreamErrorEvent {
  error: string;
  message: string;
  retryAfter?: number;
}

/**
 * Token usage carried on llm.done SSE events. Mirrors the runtime's
 * canonical `TokenUsage` (src/usage/types.ts). Web is a separate package
 * so the shape is duplicated rather than imported — keep in sync.
 */
export interface UsageShape {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LlmDoneEvent {
  runId: string;
  model: string;
  /** Token usage for this single LLM call (canonical AI SDK V3 shape). */
  usage: UsageShape;
  llmMs: number;
  /**
   * Per-call finish reason (AI SDK V3 unified). Optional for backward
   * compat; surfaces length truncation, content filter, etc. so the UI
   * can render a per-message indicator.
   */
  finishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
}

/** Chat stream SSE event type to payload mapping. */
export interface ChatStreamEventMap {
  "chat.start": { conversationId: string };
  "text.delta": TextDeltaEvent;
  "reasoning.delta": ReasoningDeltaEvent;
  "tool.preparing": ToolPreparingEvent;
  "tool.preparing.done": ToolPreparingDoneEvent;
  "tool.start": ToolStartEvent;
  "tool.done": ToolDoneEvent;
  "llm.done": LlmDoneEvent;
  done: ChatResult;
  error: StreamErrorEvent;
}

/** Union of all chat stream event type strings. */
export type ChatStreamEventType = keyof ChatStreamEventMap;

/** Runtime configuration info from get_config tool. */
export interface ConfigInfo {
  defaultModel: string;
  configuredProviders: string[];
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  preferences?: {
    displayName?: string;
    timezone?: string;
    locale?: string;
    theme?: string;
  };
}

/** Bootstrap response from GET /v1/bootstrap — single startup payload. */
export interface BootstrapResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    orgRole: string;
    preferences: { displayName?: string; timezone?: string; locale?: string; theme?: string };
  };
  workspaces: Array<{
    id: string;
    name: string;
    /**
     * The signed-in user's role within this workspace. Drives the
     * workspace-scoped permission UX (see `useScopedRole`). Tightened to
     * the literal union so a future server change can't silently widen it
     * back to `string` — that regression dropped every non-admin's
     * settings nav to "About only" until detected in production.
     */
    role: "admin" | "member";
    memberCount: number;
    bundleCount: number;
  }>;
  activeWorkspace: string | null;
  shell: {
    placements: PlacementEntry[];
    chatEndpoint: string;
    eventsEndpoint: string;
  };
  config: {
    models: Record<string, string>;
    configuredProviders: string[];
    maxIterations: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  version: string;
  buildSha: string | null;
}

/** API error response shape. */
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// --- Shell / Placement Types ---

/** A single placement entry from the shell manifest. */
export interface PlacementEntry {
  serverName: string;
  slot: string;
  resourceUri: string;
  priority: number;
  label?: string;
  icon?: string;
  route?: string;
  size?: "compact" | "full" | "auto";
}
