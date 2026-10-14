// ---------------------------------------------------------------------------
// The events the two SSE streams send to a client, by stream.
//
// `WorkspaceStreamEvents` is `GET /v1/events`; `ConversationStreamEvents` is
// `GET /v1/conversations/:id/events`. Each maps an
// SSE `event:` name to its `data:` payload.
//
// Each catalog is also the stream's allowlist: an engine event reaches a client
// only if its stream's catalog lists it (`SSE_ROUTES` in `src/api/events.ts`,
// `STREAMED_RUN_EVENTS` in `src/runtime/turn-stream.ts`). An event no client
// reads is not listed, so it stays on the server; the system prompt in
// `run.start` and connector skill bodies are the reason that matters.
//
// Like `responses.ts`, this module imports nothing outside this directory, so
// `bun run codegen` emits it into `web/src/_generated/api/` on its own. An
// engine event forwarded to a stream is restated here from
// `EngineEventPayloads`, and `events-drift-guard.ts` holds each restatement to
// its source: the same keys, and the engine payload assignable to the wire one.
// A field whose type another package owns (an AI SDK content block) is restated
// as loosely as the web needs it.
// ---------------------------------------------------------------------------

import type { ChatResponse, PlacementEntry, TokenUsage, ToolCallResponse } from "./responses.ts";

// ── Shared shapes ───────────────────────────────────────────────────────────

/** Mirrors `ConnectionState` (`src/connectors/runtime/connection.ts`). */
export type ConnectionState =
  | "starting"
  | "running"
  | "crashed"
  | "dead"
  | "stopped"
  | "not_authenticated"
  | "pending_auth"
  | "reauth_required";

/** Mirrors `PlacementDeclaration` (`src/connectors/runtime/types.ts`). */
export type PlacementDeclaration = Omit<PlacementEntry, "serverName" | "priority" | "wsId"> & {
  priority?: number;
};

/** Mirrors `ConnectorUiMeta` (`src/connectors/runtime/types.ts`). */
export interface ConnectorUiMeta {
  placements?: PlacementDeclaration[];
}

/** Mirrors `ResourceLinkInfo` (`src/engine/content-helpers.ts`). */
export interface ResourceLinkInfo {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

/** Mirrors `SkillsLoadedEntry` (`src/engine/schemas/events.ts`). */
export interface SkillsLoadedEntry {
  id: string;
  /** The skill's own name. */
  name: string;
  /** The MCP server that published the skill, when one did. */
  connector?: string;
  /** Loading mechanism's layer: 0 = always-on, 3 = tool-affinity, 4 = trigger. */
  layer: 0 | 3 | 4;
  scope: "org" | "workspace" | "user" | "provided";
  version: string;
  tokens: number;
  /** SHA-256 hex of the skill body composed into the prompt. */
  contentHash: string;
  loadedBy: "always" | "tool_affinity" | "trigger";
  reason: string;
}

/** The AI SDK unified finish reason. */
export type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

/** A periodic keepalive. Carries nothing a client needs. */
export interface HeartbeatEvent {
  timestamp: string;
}

// ── GET /v1/events ──────────────────────────────────────────────────────────

/** A connector was installed in a workspace. */
export interface ConnectorInstalledEvent {
  wsId: string;
  serverName: string;
  connectorName: string;
  version: string;
  ui: ConnectorUiMeta | null;
  placements: PlacementDeclaration[] | null;
}

/** A connector was removed from a workspace. */
export interface ConnectorUninstalledEvent {
  serverName: string;
  connectorName: string;
  wsId: string;
}

/** A remote connector's connection changed state for one principal. */
export interface ConnectionStateChangedEvent {
  wsId: string;
  serverName: string;
  connectorName: string;
  principalId: string;
  state: ConnectionState;
  authorizationUrl?: string;
  lastError?: string;
}

interface ServerNotificationFields {
  /** The bare server name, an iframe's `data-app`. */
  server: string;
  /** One of the host's relayed notification methods. */
  method: string;
  params?: Record<string, unknown>;
}

/** An app server's notification, for that server's views. Names exactly one owner. */
export type ServerNotificationEvent =
  | (ServerNotificationFields & { workspaceId: string })
  | (ServerNotificationFields & { userId: string });

/** A conversation got its title. Sent to its owner only. */
export interface ConversationTitleEvent {
  conversationId: string;
  title: string;
  ownerId: string;
}

/** Configuration or preferences changed; `fields` names what. */
export interface ConfigChangedEvent {
  fields: string[];
}

/** A notification reached a workspace's inbox. */
export interface NotificationCreatedEvent {
  workspaceId: string;
  /** `<source>:<eventId>`, the notification's wire id. */
  id: string;
  /** Position in the workspace's inbox; the `?after=` cursor. */
  seq: number;
  source: string;
  name: string;
  level: "info" | "attention" | "urgent";
  title: string;
  subject?: string;
  receivedAt: string;
  /** Items unread in this workspace's inbox once this one landed. */
  unread: number;
}

/** Items in a workspace's inbox were marked read. */
export interface NotificationReadEvent {
  workspaceId: string;
  /** The wire ids this mark changed. */
  ids: string[];
  /** Items unread in this workspace's inbox after the mark. */
  unread: number;
}

/** A notification route target delivered. */
export interface NotificationDeliveredEvent {
  workspaceId: string;
  id: string;
  seq: number;
  routeId: string;
  target: string;
  attempts: number;
}

/** A notification route target reached a terminal outcome other than delivery. */
export interface NotificationDeliveryFailedEvent extends NotificationDeliveredEvent {
  outcome: "pending" | "denied" | "skipped" | "failed";
  classification?: string;
  error?: string;
}

/** Every event `GET /v1/events` sends, by SSE event name. */
export interface WorkspaceStreamEvents {
  heartbeat: HeartbeatEvent;
  "connector.installed": ConnectorInstalledEvent;
  "connector.uninstalled": ConnectorUninstalledEvent;
  "connection.state_changed": ConnectionStateChangedEvent;
  "server.notification": ServerNotificationEvent;
  "conversation.title": ConversationTitleEvent;
  "config.changed": ConfigChangedEvent;
  "notification.created": NotificationCreatedEvent;
  "notification.read": NotificationReadEvent;
  "notification.delivered": NotificationDeliveredEvent;
  "notification.delivery_failed": NotificationDeliveryFailedEvent;
}

// ── GET /v1/conversations/:id/events ────────────────────────────────────────

/** The first frame of every subscription. */
export interface SubscribedEvent {
  /** Whether a turn is in flight. */
  isActive: boolean;
  /** The in-flight turn's latest sequence number. */
  activeSeq: number;
}

/** The user's message that started a turn. */
export interface UserMessageEvent {
  content: string;
  userId?: string;
  /** Set on a frame a peer tab broadcast; absent from a turn's own replay. */
  displayName?: string;
  timestamp: string;
}

/** The turn was stopped. */
export type CancelledEvent = Record<string, never>;

/** The turn failed. */
export interface StreamErrorEvent {
  /** Machine-readable error code. */
  error: string;
  message: string;
}

/** A turn's conversation is resolved and its run is about to start. */
export interface ChatStartEvent {
  conversationId: string;
  /** The model the conversation is bound to. */
  model: string;
}

/** Streamed model text (`text.delta`) or reasoning (`reasoning.delta`). */
export interface TextDeltaEvent {
  runId: string;
  text: string;
}

/** The model began streaming a tool call's arguments. */
export interface ToolPreparingEvent {
  runId: string;
  id: string;
  name: string;
}

/** A tool call is about to execute, with the input as the model sent it. */
export interface ToolStartEvent {
  runId: string;
  name: string;
  id: string;
  /** The tool's inline `ui://` binding, when it has one. */
  resourceUri?: string;
  input: Record<string, unknown>;
}

/** A tool's raw result, sent when the tool has an inline UI binding. */
export interface ToolResultPayload extends ToolCallResponse {
  _meta?: Record<string, unknown>;
}

/** A tool call finished. */
export interface ToolDoneEvent {
  runId: string;
  name: string;
  id: string;
  ok: boolean;
  ms: number;
  resourceUri?: string;
  /** The full output text. */
  output: string;
  result?: ToolResultPayload;
  /** The bounded text the model saw, when it differs from `output`. */
  modelOutput?: string;
  resourceLinks?: ResourceLinkInfo[];
  supervisorTripped?: true;
  trippedTool?: string;
  consecutiveRepeats?: number;
  /** The workspace the call ran in. */
  workspaceId?: string;
}

/** A provider call completed. */
export interface LlmDoneEvent {
  runId: string;
  model: string;
  /** AI SDK content blocks. */
  content: unknown[];
  usage: TokenUsage;
  llmMs: number;
  ttftMs?: number;
  estimatedInputTokens: number;
  finishReason: FinishReason;
  finishReasonRaw?: string;
}

/** The skills composed into this turn's prompt. */
export interface SkillsLoadedEvent {
  runId: string;
  skills: SkillsLoadedEntry[];
  totalTokens: number;
}

/** The frames the runtime builds for a turn itself; every other run frame is a forwarded engine event. */
export type TurnFrame = "user.message" | "done" | "cancelled" | "error";

/** The stream's control frames, which carry no turn content. */
export type ControlFrame = "subscribed" | "heartbeat";

/** Every event `GET /v1/conversations/:id/events` sends, by SSE event name. */
export interface ConversationStreamEvents {
  subscribed: SubscribedEvent;
  heartbeat: HeartbeatEvent;
  "user.message": UserMessageEvent;
  done: ChatResponse;
  cancelled: CancelledEvent;
  error: StreamErrorEvent;
  "chat.start": ChatStartEvent;
  "text.delta": TextDeltaEvent;
  "reasoning.delta": TextDeltaEvent;
  "tool.preparing": ToolPreparingEvent;
  "tool.start": ToolStartEvent;
  "tool.done": ToolDoneEvent;
  "llm.done": LlmDoneEvent;
  "skills.loaded": SkillsLoadedEvent;
}
