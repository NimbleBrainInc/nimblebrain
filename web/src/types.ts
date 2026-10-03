// REST response bodies are the server's own types, generated from
// `src/api/schemas/responses.ts`. Import them from here or from the generated
// module; never restate one.

// SSE events, by stream, generated from `src/api/schemas/events.ts`.
export type {
  ChatStartEvent,
  ConfigChangedEvent,
  ConnectionStateChangedEvent,
  ConversationStreamEvents,
  ConversationTitleEvent,
  LlmDoneEvent,
  NotificationCreatedEvent,
  NotificationDeliveredEvent,
  NotificationDeliveryFailedEvent,
  NotificationReadEvent,
  ServerNotificationEvent,
  StreamErrorEvent,
  TextDeltaEvent,
  ToolDoneEvent,
  ToolPreparingEvent,
  ToolStartEvent,
  UserMessageEvent,
  WorkspaceStreamEvents,
} from "./_generated/api/events";
export type {
  ApiErrorBody,
  BootstrapResponse,
  ChatResponse,
  ChatStartResponse,
  ComposioInitiateResponse,
  FileEntry,
  FileLimits,
  OAuthInitiateResponse,
  PlacementEntry,
  ReadResourceResponse,
  ResourceContents,
  ShellResponse,
  ToolCallResponse,
  UploadResourceResponse,
} from "./_generated/api/responses";

/** Context identifying the app/server the user is interacting with. */
export interface AppContext {
  appName: string;
  serverName: string;
  /** UI state pushed by the app via Synapse updateModelContext(). */
  appState?: {
    state: Record<string, unknown>;
    summary?: string;
    updatedAt: string;
  };
}

/** Chat request body for POST /v1/workspaces/:wsId/chat and POST /v1/workspaces/:wsId/chat/stream. */
export interface ChatRequest {
  message: string;
  conversationId?: string;
  model?: string;
  maxIterations?: number;
  appContext?: AppContext;
}

// --- Chat stream projections ---

/** Which tier a skill lives in — mirrors the server `SkillScope`. */
export type LedgerSkillScope = "org" | "workspace" | "user" | "provided";

/**
 * One skill in a turn's `skills.loaded` telemetry, projected to what the
 * Context Ledger renders. A structural subset of the wire entry (which also
 * carries `layer`, `version`, `contentHash`) — the ledger only needs
 * provenance and cost. `loadedBy` is the loading mechanism; the drawer shows
 * the verbatim `reason` instead, so extra future mechanisms need no UI change.
 *
 * `name` is required here even though the wire field is optional: every path
 * that reaches this type resolves it — the live event carries it from
 * `buildSkillsLoadedPayload`, and both read paths (the `compose` tool and the
 * conversations app's replay projection) fill it in for runs recorded before
 * the field existed. That is what lets a renderer print `skill.name` instead of
 * picking a name out of `id`.
 */
export interface LedgerSkill {
  id: string;
  name: string;
  /** The MCP server that published it; absent for filesystem skills. */
  connector?: string;
  scope: LedgerSkillScope;
  tokens: number;
  loadedBy: "always" | "tool_affinity" | "trigger";
  reason: string;
}

/**
 * The parts of `get_config` the chat surface consumes. The tool publishes more
 * — the operator-set group and the resolved limits under `resolved` — and the
 * settings tabs declare those where they use them.
 */
export interface ConfigInfo {
  configuredProviders: string[];
  /**
   * What this caller's next conversation will be created with. The runtime
   * resolves it — preference over configured default, re-checked against
   * policy — so the client states it rather than recomputing the precedence.
   */
  newConversationModel?: string;
  /** The models this deployment offers, already filtered by policy. */
  availableModels?: Record<string, { id: string; name?: string }[]>;
  preferences?: {
    displayName?: string;
    timezone?: string;
    locale?: string;
    theme?: string;
  };
}
