// ---------------------------------------------------------------------------
// Engine event payloads — one named schema per event type.
//
// `EngineEventPayloads` at the bottom maps every event type to its payload, and
// `EngineEvent` (`src/engine/types.ts`) is derived from it: an emit whose `data`
// does not match its `type`'s schema fails the build, and a consumer that
// narrows on `event.type` reads a typed payload. A type means one shape; an
// event that reports something different is a different type.
//
// TypeBox, not bare interfaces, so each payload is also a JSON Schema: the
// declarative contract an event consumer outside the process can be given.
// Fields whose type is owned elsewhere (an AI SDK content block, a `ToolResult`)
// are `opaque<T>()`: the static type is exact, the JSON Schema says only what
// the field is. Nothing validates events at runtime; the engine emits from code
// we own, and the bug class is a wrong shape, which the compiler catches.
// ---------------------------------------------------------------------------

import type { LanguageModelV4Content, LanguageModelV4Message } from "@ai-sdk/provider";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { ConnectionState } from "../../connectors/runtime/connection.ts";
import type { ConnectorUiMeta, PlacementDeclaration } from "../../connectors/runtime/types.ts";
import type { UnattendedDispatchClassification } from "../../orchestrator/unattended-dispatch.ts";
import type { SealFailureReason } from "../../tools/credential-store.ts";
import type { RelayedServerNotificationMethod } from "../../tools/server-notifications.ts";
import type { TokenUsage } from "../../usage/types.ts";
import type { ResourceLinkInfo } from "../content-helpers.ts";
import type { FinishReason, StopReason, ToolResult } from "../types.ts";

/**
 * A field whose type another module owns. The static type is `T`; the JSON
 * Schema records only the description, because TypeBox cannot restate `T`.
 */
function opaque<T>(description: string): TSchema & { static: T } {
  return Type.Unsafe<T>(Type.Unknown({ description }));
}

/** A key that is always present but may hold `undefined` (`{ k: x }` with `x` possibly undefined). */
function maybe<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Undefined()]));
}

// Plain `Type.Union([Type.Literal(...)])` rather than the `StringEnum`
// helper used in platform tool schemas. The platform-tool schemas need
// the legacy `{type: "string", enum: [...]}` JSON Schema form (so AJV
// and external MCP clients see the expected shape); event schemas live
// inside the process and are walked by TypeBox's `Value.Check`, which
// requires the standard `Kind` discriminator that `Type.Unsafe` (used
// in `StringEnum`) omits.

const SkillScope = Type.Union([
  Type.Literal("org"),
  Type.Literal("workspace"),
  Type.Literal("user"),
  Type.Literal("provided"),
]);
const WritableSkillScope = Type.Union([
  Type.Literal("org"),
  Type.Literal("workspace"),
  Type.Literal("user"),
]);

export const SkillsLoadedEntry = Type.Object({
  id: Type.String(),
  name: Type.Optional(
    Type.String({
      description:
        "The skill's own name. Optional because events recorded before the " +
        "field existed are read back through this shape.",
    }),
  ),
  connector: Type.Optional(
    Type.String({ description: "MCP server that published the skill, when one did." }),
  ),
  layer: Type.Union([Type.Literal(0), Type.Literal(3), Type.Literal(4)], {
    description: "Loading mechanism's layer: 0 = always-on, 3 = tool-affinity, 4 = trigger.",
  }),
  scope: SkillScope,
  version: Type.String(),
  tokens: Type.Number(),
  contentHash: Type.String({
    description: "SHA-256 hex of the skill body composed into the prompt.",
  }),
  loadedBy: Type.Union([
    Type.Literal("always"),
    Type.Literal("tool_affinity"),
    Type.Literal("trigger"),
  ]),
  reason: Type.String(),
});
export type SkillsLoadedEntry = Static<typeof SkillsLoadedEntry>;

export const SkillsLoadedPayload = Type.Object({
  skills: Type.Array(SkillsLoadedEntry),
  totalTokens: Type.Number(),
  /** Engine-attached run id for debug/correlation. Set by engine.run(). */
  runId: Type.Optional(Type.String()),
});
export type SkillsLoadedPayload = Static<typeof SkillsLoadedPayload>;

export const ContextAssembledSource = Type.Object({
  kind: Type.String(),
  count: Type.Optional(Type.Number()),
  tokens: Type.Number(),
  toolSetHash: Type.Optional(Type.String()),
  version: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  userId: Type.Optional(Type.String()),
  messages: Type.Optional(
    Type.Number({ description: "`history`: how many messages the windowed history holds." }),
  ),
  turns: Type.Optional(
    Type.Number({
      description:
        "`history`, as recorded before `messages` existed — the same message " +
        "count under a name that read as conversational turns.",
    }),
  ),
  compacted: Type.Optional(Type.Boolean()),
});
export type ContextAssembledSource = Static<typeof ContextAssembledSource>;

export const ContextAssembledPayload = Type.Object({
  sources: Type.Array(ContextAssembledSource),
  excluded: Type.Array(ContextAssembledSource),
  totalTokens: Type.Number(),
  modelMaxContext: Type.Optional(Type.Number()),
  headroomTokens: Type.Optional(Type.Number()),
  /** Engine-attached run id for debug/correlation. */
  runId: Type.Optional(Type.String()),
});
export type ContextAssembledPayload = Static<typeof ContextAssembledPayload>;

const ServerNotificationFields = {
  server: Type.String(),
  method: opaque<RelayedServerNotificationMethod>("One of `RELAYED_SERVER_NOTIFICATIONS`."),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};

/**
 * An app server's notification, relayed to that server's views. `server` is the
 * bare server name (an iframe's `data-app`), `method` one of
 * `RELAYED_SERVER_NOTIFICATIONS`, `params` what the SDK parsed, size-capped.
 *
 * It names exactly one owner: `workspaceId` for a workspace's source, or
 * `userId` for a person's own app, which belongs to no workspace.
 */
export const ServerNotificationPayload = Type.Union([
  Type.Object({ ...ServerNotificationFields, workspaceId: Type.String() }),
  Type.Object({ ...ServerNotificationFields, userId: Type.String() }),
]);
export type ServerNotificationPayload = Static<typeof ServerNotificationPayload>;

export const ToolPromotionChangedPayload = Type.Object({
  runId: Type.String(),
  toolName: Type.String(),
  /**
   * Why the change happened. Absent for normal agent-driven add/remove.
   * Present (`"evicted"`) when the engine reclaimed a slot under the
   * `maxActiveTools` cap.
   */
  reason: Type.Optional(Type.String()),
});
export type ToolPromotionChangedPayload = Static<typeof ToolPromotionChangedPayload>;

const SkillEventCommonFields = {
  id: Type.String({ description: "Filesystem path of the skill." }),
  name: Type.String(),
  scope: WritableSkillScope,
};

export const SkillCreatedPayload = Type.Object(SkillEventCommonFields);
export type SkillCreatedPayload = Static<typeof SkillCreatedPayload>;

export const SkillUpdatedPayload = Type.Object({
  ...SkillEventCommonFields,
});
export type SkillUpdatedPayload = Static<typeof SkillUpdatedPayload>;

export const SkillDeletedPayload = Type.Object(SkillEventCommonFields);
export type SkillDeletedPayload = Static<typeof SkillDeletedPayload>;

/**
 * `connector.skill.injected` — a curated connector overlay surfaced into
 * the conversation history for the first time, triggered by a matching
 * connector tool call. The reconstructor turns this into a synthetic
 * message; the body is wrapped in `<connector-skill>` containment at that point.
 */
export const ConnectorSkillInjectedPayload = Type.Object({
  /** Engine-attached run id for debug/correlation. */
  runId: Type.String(),
  /** The connector tool call that triggered the surfacing (e.g. `gmail__send`). */
  toolName: Type.String(),
  /** The overlay's skill name (matches the materialized manifest `name`). */
  skillName: Type.String(),
  /** The overlay body (markdown), surfaced verbatim into history. */
  skillBody: Type.String(),
  /** Scope label for containment / telemetry. Always `"connector"` in v1. */
  scope: Type.String(),
});
export type ConnectorSkillInjectedPayload = Static<typeof ConnectorSkillInjectedPayload>;

export const NotificationCreatedPayload = Type.Object({
  workspaceId: Type.String({
    description: "The workspace whose inbox this landed in. Scopes the SSE fan-out.",
  }),
  id: Type.String({ description: "`<source>:<eventId>` — the notification's wire id." }),
  seq: Type.Number({
    description: "Monotonic position in the workspace's inbox; the `?after=` cursor.",
  }),
  source: Type.String({ description: "Connector server name the runtime stamped." }),
  name: Type.String({ description: "The server's own event name." }),
  level: Type.Union([Type.Literal("info"), Type.Literal("attention"), Type.Literal("urgent")]),
  title: Type.String({
    description: "One line of server-authored plain text, sanitized and capped on parse.",
  }),
  subject: Type.Optional(Type.String({ description: "What the item is about, for grouping." })),
  receivedAt: Type.String({ description: "ISO 8601 instant the runtime wrote the item." }),
});
export type NotificationCreatedPayload = Static<typeof NotificationCreatedPayload>;

export const UnattendedDispatchPayload = Type.Object({
  principalId: Type.String({
    description: "The user the call ran as — supplied by in-process config, never by a request.",
  }),
  workspaceId: Type.String({ description: "The one workspace the call was walled to." }),
  tool: Type.String({ description: "The bare `<source>__<tool>` name the caller asked for." }),
  reason: Type.String({
    description: "The caller's own short opaque string (e.g. `route:rt_…`). Opaque to the host.",
  }),
  outcome: Type.Union([
    Type.Literal("ok"),
    Type.Literal("denied"),
    Type.Literal("skipped"),
    Type.Literal("error"),
  ]),
  classification: Type.Optional(
    opaque<UnattendedDispatchClassification>("Why, for every outcome but `ok`. Absent on success."),
  ),
  ms: Type.Number({ description: "Wall-clock time the dispatch took, including the gates." }),
});
export type UnattendedDispatchPayload = Static<typeof UnattendedDispatchPayload>;

export const AdminToolCallPayload = Type.Object({
  workspaceId: Type.String({ description: "The workspace the call was made in." }),
  userId: Type.Union([Type.String(), Type.Null()], {
    description:
      "The person the call ran as: the chat user, the run's owner, or the dispatch's principal.",
  }),
  connector: Type.String({ description: "The connector's source name." }),
  tool: Type.String({ description: "The bare tool name." }),
  caller: Type.Union(
    [
      Type.Literal("chat"),
      Type.Literal("automation"),
      Type.Literal("dispatch"),
      Type.Literal("app"),
      Type.Literal("mcp"),
      Type.Literal("api"),
    ],
    { description: "The door the call came through (`AdminToolCaller`)." },
  ),
  outcome: Type.Union([Type.Literal("admitted"), Type.Literal("refused")], {
    description:
      "The role gate's answer. `admitted` is not success: the connector may still refuse the call.",
  }),
  arguments: Type.Record(Type.String(), Type.Unknown(), {
    description: "The call's arguments, with every `writeOnly` property's value redacted.",
  }),
  conversationId: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
});
export type AdminToolCallPayload = Static<typeof AdminToolCallPayload>;

// ── Run lifecycle ───────────────────────────────────────────────────────────

/** A chat turn's conversation is resolved and the run is about to start. */
export const ChatStartPayload = Type.Object({
  conversationId: Type.String(),
  /** The conversation's bound model; absent when it has none. */
  model: Type.Optional(Type.String()),
});
export type ChatStartPayload = Static<typeof ChatStartPayload>;

/** The engine is starting a run: its configuration and the prompt it assembled. */
export const RunStartPayload = Type.Object({
  runId: Type.String(),
  model: Type.String(),
  maxIterations: Type.Number(),
  maxOutputTokens: Type.Number(),
  maxInputTokens: Type.Number(),
  toolCount: Type.Number(),
  toolNames: Type.Array(Type.String()),
  systemPromptLength: Type.Number(),
  systemPrompt: Type.String(),
  messageCount: Type.Number(),
  messageRoles: opaque<LanguageModelV4Message["role"][]>("The role of each message sent."),
  estimatedMessageTokens: Type.Number(),
});
export type RunStartPayload = Static<typeof RunStartPayload>;

/** A run finished, completed or cancelled. */
export const RunDonePayload = Type.Object({
  runId: Type.String(),
  stopReason: opaque<StopReason>("Why the loop stopped (`StopReason`)."),
  iterations: Type.Number(),
  totalMs: Type.Number(),
});
export type RunDonePayload = Static<typeof RunDonePayload>;

/** A run failed. */
export const RunErrorPayload = Type.Object({
  runId: Type.String(),
  error: Type.String({ description: "The error's message." }),
  type: Type.String({ description: "The error's class name." }),
});
export type RunErrorPayload = Static<typeof RunErrorPayload>;

// ── Streaming output ────────────────────────────────────────────────────────

/** A piece of streamed model text (`text.delta`) or reasoning (`reasoning.delta`). */
export const TextDeltaPayload = Type.Object({
  runId: Type.String(),
  text: Type.String(),
});
export type TextDeltaPayload = Static<typeof TextDeltaPayload>;

/** The model began streaming a tool call's arguments. */
export const ToolPreparingPayload = Type.Object({
  runId: Type.String(),
  id: Type.String({ description: "The tool call id." }),
  name: Type.String(),
});
export type ToolPreparingPayload = Static<typeof ToolPreparingPayload>;

/** The model finished streaming a tool call's arguments. */
export const ToolPreparingDonePayload = Type.Object({
  runId: Type.String(),
  id: Type.String({ description: "The tool call id." }),
});
export type ToolPreparingDonePayload = Static<typeof ToolPreparingDonePayload>;

// ── Tool calls ──────────────────────────────────────────────────────────────

/** A tool call is about to execute, with the input as the model sent it (before coercion). */
export const ToolStartPayload = Type.Object({
  runId: Type.String(),
  name: Type.String(),
  id: Type.String(),
  resourceUri: maybe(Type.String({ description: "The tool's inline `ui://` binding." })),
  input: Type.Record(Type.String(), Type.Unknown()),
});
export type ToolStartPayload = Static<typeof ToolStartPayload>;

/** A tool call finished. */
export const ToolDonePayload = Type.Object({
  runId: Type.String(),
  name: Type.String(),
  id: Type.String(),
  ok: Type.Boolean(),
  ms: Type.Number(),
  resourceUri: maybe(Type.String({ description: "The tool's inline `ui://` binding." })),
  output: Type.String({ description: "The full output text, audience-filtered." }),
  result: maybe(opaque<ToolResult>("The raw result, when the tool has an inline UI binding.")),
  modelOutput: Type.Optional(
    Type.String({ description: "The bounded text the model saw, when it differs from `output`." }),
  ),
  resourceLinks: Type.Optional(opaque<ResourceLinkInfo[]>("MCP `resource_link` blocks.")),
  supervisorTripped: Type.Optional(Type.Literal(true)),
  trippedTool: Type.Optional(Type.String()),
  consecutiveRepeats: Type.Optional(Type.Number()),
  workspaceId: Type.Optional(
    Type.String({ description: "The workspace the call ran in, stamped by the runtime." }),
  ),
});
export type ToolDonePayload = Static<typeof ToolDonePayload>;

/** A running tool call reported progress. */
export const ToolProgressPayload = Type.Object({
  runId: Type.String(),
  id: Type.String({ description: "The tool call id." }),
  message: Type.String(),
  workspaceId: Type.Optional(
    Type.String({ description: "The workspace the call ran in, stamped by the runtime." }),
  ),
});
export type ToolProgressPayload = Static<typeof ToolProgressPayload>;

/** A task-augmented MCP tool call changed status: created, working, done, or cancelled. */
export const ToolTaskStatusPayload = Type.Object({
  source: Type.String({ description: "The MCP source's name." }),
  tool: Type.String(),
  taskId: Type.Optional(Type.String({ description: "Absent when the call was cancelled." })),
  status: Type.String({ description: "The MCP task status." }),
  message: maybe(Type.String()),
});
export type ToolTaskStatusPayload = Static<typeof ToolTaskStatusPayload>;

// ── Model calls ─────────────────────────────────────────────────────────────

/** A provider call completed. */
export const LlmDonePayload = Type.Object({
  runId: Type.String(),
  model: Type.String(),
  content: opaque<LanguageModelV4Content[]>("AI SDK V4 content blocks."),
  usage: opaque<TokenUsage>("Token usage for this call (`TokenUsage`)."),
  llmMs: Type.Number(),
  ttftMs: maybe(Type.Number({ description: "Time to first token; absent with no output part." })),
  estimatedInputTokens: Type.Number(),
  finishReason: opaque<FinishReason>("AI SDK unified finish reason."),
  finishReasonRaw: Type.Optional(Type.String({ description: "The provider's own stop reason." })),
});
export type LlmDonePayload = Static<typeof LlmDonePayload>;

/** A provider call failed terminally (retries exhausted). Not emitted for a cancellation. */
export const LlmErrorPayload = Type.Object({
  runId: Type.String(),
  model: Type.String(),
});
export type LlmErrorPayload = Static<typeof LlmErrorPayload>;

/** A call was rejected for exceeding the context window; history is re-windowed and retried. */
export const ContextOverflowRecoveryPayload = Type.Object({
  runId: Type.String(),
  attempt: Type.Number(),
  previousMessageCount: Type.Number(),
  errorMessage: Type.String(),
});
export type ContextOverflowRecoveryPayload = Static<typeof ContextOverflowRecoveryPayload>;

// ── Skills in a run ─────────────────────────────────────────────────────────

/** A catalog skill's body reached the model through `nb__use_skill`. */
export const SkillActivatedPayload = Type.Object({
  runId: Type.String(),
  toolCallId: Type.String(),
  skillName: Type.String(),
  scope: Type.String(),
  tokens: Type.Number(),
});
export type SkillActivatedPayload = Static<typeof SkillActivatedPayload>;

/** A skill's surfacing was suppressed or restored for the conversation. */
export const SkillSuppressionPayload = Type.Object({
  runId: Type.String(),
  skillName: Type.String(),
  suppressed: Type.Boolean(),
});
export type SkillSuppressionPayload = Static<typeof SkillSuppressionPayload>;

// ── Connectors ──────────────────────────────────────────────────────────────

/** A connector was installed in a workspace. */
export const ConnectorInstalledPayload = Type.Object({
  wsId: Type.String(),
  serverName: Type.String(),
  connectorName: Type.String(),
  version: Type.String(),
  ui: Type.Union([opaque<ConnectorUiMeta>("The connector's UI metadata."), Type.Null()]),
  placements: Type.Union([
    opaque<PlacementDeclaration[]>("Where the connector's UI is placed."),
    Type.Null(),
  ]),
});
export type ConnectorInstalledPayload = Static<typeof ConnectorInstalledPayload>;

/** A connector was removed from a workspace. */
export const ConnectorUninstalledPayload = Type.Object({
  serverName: Type.String(),
  connectorName: Type.String(),
  wsId: Type.String(),
});
export type ConnectorUninstalledPayload = Static<typeof ConnectorUninstalledPayload>;

/**
 * A remote connector's connection changed state for one principal:
 * `_workspace` for a workspace-scoped connector, else a member's id.
 */
export const ConnectionStateChangedPayload = Type.Object({
  wsId: Type.String(),
  serverName: Type.String(),
  connectorName: Type.String(),
  principalId: Type.String(),
  state: opaque<ConnectionState>("The connection's state (`ConnectionState`)."),
  authorizationUrl: Type.Optional(Type.String()),
  lastError: Type.Optional(Type.String()),
});
export type ConnectionStateChangedPayload = Static<typeof ConnectionStateChangedPayload>;

/**
 * A connector source's liveness changed. `source.*` comes from the source
 * itself (its process crashed, or restarted); `connector.*` from the health
 * monitor's sweep (found down, backing off, restarting, recovered).
 */
export const ConnectorHealthPayload = Type.Object({
  source: Type.String({ description: "The source's name." }),
  event: Type.Union([
    Type.Literal("source.crashed"),
    Type.Literal("source.restarted"),
    Type.Literal("source.restart_failed"),
    Type.Literal("connector.crashed"),
    Type.Literal("connector.cooldown"),
    Type.Literal("connector.restarting"),
    Type.Literal("connector.recovered"),
  ]),
  error: Type.Optional(Type.String()),
  remote: Type.Optional(Type.Literal(true)),
  retryInMs: Type.Optional(Type.Number({ description: "`connector.cooldown`: the wait." })),
  attempt: Type.Optional(Type.Number({ description: "`connector.restarting`: the attempt." })),
  delayMs: Type.Optional(Type.Number({ description: "`connector.restarting`: the backoff." })),
});
export type ConnectorHealthPayload = Static<typeof ConnectorHealthPayload>;

// ── Workspace and identity changes ──────────────────────────────────────────

/** A conversation got its title. Names the owner, not a workspace. */
export const ConversationTitlePayload = Type.Object({
  conversationId: Type.String(),
  title: Type.String(),
  ownerId: Type.String(),
});
export type ConversationTitlePayload = Static<typeof ConversationTitlePayload>;

/** Configuration or preferences changed; `fields` names what. */
export const ConfigChangedPayload = Type.Object({
  fields: Type.Array(Type.String()),
});
export type ConfigChangedPayload = Static<typeof ConfigChangedPayload>;

/** An iframe app called a tool through the bridge. */
export const BridgeToolCallPayload = Type.Object({
  name: Type.String(),
  id: Type.String(),
  server: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  workspaceId: Type.Union([Type.String(), Type.Null()]),
});
export type BridgeToolCallPayload = Static<typeof BridgeToolCallPayload>;

/** A bridge tool call finished. */
export const BridgeToolDonePayload = Type.Object({
  name: Type.String(),
  id: Type.String(),
  ok: Type.Boolean(),
  ms: Type.Number(),
  userId: Type.Union([Type.String(), Type.Null()]),
  workspaceId: Type.Union([Type.String(), Type.Null()]),
});
export type BridgeToolDonePayload = Static<typeof BridgeToolDonePayload>;

const NotificationDeliveryFields = {
  workspaceId: Type.String(),
  id: Type.String({ description: "The notification's wire id." }),
  seq: Type.Number(),
  routeId: Type.String(),
  target: Type.String(),
  attempts: Type.Number(),
};

/** A notification route target delivered. */
export const NotificationDeliveredPayload = Type.Object(NotificationDeliveryFields);
export type NotificationDeliveredPayload = Static<typeof NotificationDeliveredPayload>;

/** A notification route target reached a terminal outcome other than delivery. */
export const NotificationDeliveryFailedPayload = Type.Object({
  ...NotificationDeliveryFields,
  outcome: Type.Union([
    Type.Literal("pending"),
    Type.Literal("denied"),
    Type.Literal("skipped"),
    Type.Literal("failed"),
  ]),
  classification: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export type NotificationDeliveryFailedPayload = Static<typeof NotificationDeliveryFailedPayload>;

// ── Operations and audit ────────────────────────────────────────────────────

/** A request ended in an unhandled server error. */
export const HttpErrorPayload = Type.Object({
  ts: Type.String(),
  event: Type.Literal("http.error"),
  status: Type.Number(),
  method: Type.String(),
  path: Type.String(),
  error: Type.String(),
  message: Type.String(),
  userId: Type.Union([Type.String(), Type.Null()]),
  workspaceId: Type.Union([Type.String(), Type.Null()]),
});
export type HttpErrorPayload = Static<typeof HttpErrorPayload>;

/** A request failed authentication. */
export const AuthFailurePayload = Type.Object({
  ip: Type.String(),
  method: Type.String(),
  path: Type.String(),
});
export type AuthFailurePayload = Static<typeof AuthFailurePayload>;

/** A privileged tool action was refused. */
export const PermissionDeniedPayload = Type.Object({
  tool: Type.String(),
  action: Type.String(),
  target: Type.Unknown({ description: "The input's `name` or `id`, else null." }),
});
export type PermissionDeniedPayload = Static<typeof PermissionDeniedPayload>;

const CredentialOwnerFields = {
  workspaceId: Type.Optional(Type.String({ description: "Set for a workspace-scoped secret." })),
  userId: Type.Optional(Type.String({ description: "Set for a user-scoped secret." })),
};

/** A stored secret was revealed to a caller. Never the value. */
export const CredentialReadPayload = Type.Object({
  scope: Type.String(),
  key: Type.String(),
  caller: Type.String(),
  purpose: Type.String(),
  ...CredentialOwnerFields,
});
export type CredentialReadPayload = Static<typeof CredentialReadPayload>;

/** A stored secret claimed to be sealed and could not be opened. Never the value. */
export const CredentialSealFailurePayload = Type.Object({
  scope: Type.String(),
  key: Type.String(),
  reason: opaque<SealFailureReason>("Why it could not be opened (`SealFailureReason`)."),
  wantedKid: Type.Optional(Type.String()),
  ...CredentialOwnerFields,
});
export type CredentialSealFailurePayload = Static<typeof CredentialSealFailurePayload>;

/** The credential store finished its boot reconcile. */
export const CredentialStoreReconciledPayload = Type.Object({
  sealed: Type.Boolean({ description: "Whether a sealing key is configured." }),
  strictPlaintextRefusal: Type.Boolean({
    description: "Whether plaintext secrets are refused from now on.",
  }),
});
export type CredentialStoreReconciledPayload = Static<typeof CredentialStoreReconciledPayload>;

// ── The event catalog ───────────────────────────────────────────────────────

/**
 * Every engine event type and its payload. `EngineEventType` and `EngineEvent`
 * (`src/engine/types.ts`) are derived from this map, so adding an event is one
 * entry here.
 */
export interface EngineEventPayloads {
  "chat.start": ChatStartPayload;
  "run.start": RunStartPayload;
  "run.done": RunDonePayload;
  "run.error": RunErrorPayload;
  "text.delta": TextDeltaPayload;
  "reasoning.delta": TextDeltaPayload;
  "tool.preparing": ToolPreparingPayload;
  "tool.preparing.done": ToolPreparingDonePayload;
  "tool.start": ToolStartPayload;
  "tool.done": ToolDonePayload;
  "tool.progress": ToolProgressPayload;
  "tool.task_status": ToolTaskStatusPayload;
  "tool.promoted": ToolPromotionChangedPayload;
  "tool.released": ToolPromotionChangedPayload;
  "llm.done": LlmDonePayload;
  /**
   * A provider LLM call failed terminally — the call threw and the in-call
   * retry was exhausted (or a context overflow could not be recovered).
   * NOT emitted for user-initiated cancellations (abort). Payload: { runId,
   * model }. Observe-only signal for the LLM error-rate metric; the error
   * itself still propagates and ends the run as `run.error`.
   */
  "llm.error": LlmErrorPayload;
  "skills.loaded": SkillsLoadedPayload & { runId: string };
  /**
   * A curated connector-skill overlay was surfaced into the conversation for
   * the first time, triggered by a matching connector tool call. The
   * reconstructor turns this into a synthetic message carrying the skill
   * body, placed after the tool results of the iteration that triggered it, so
   * the guidance rides the cached, append-only history and is in context for
   * the model's next action instead of re-entering the system prefix. Emitted
   * at most once per (conversation, skill). Payload: { runId, toolName,
   * skillName, skillBody, scope }.
   */
  "connector.skill.injected": ConnectorSkillInjectedPayload;
  /**
   * A catalog skill's full body was delivered to the model via the
   * `nb__use_skill` activation tool. The body itself persists as the tool
   * result (`tool.done`), so — unlike `connector.skill.injected` — the
   * reconstructor synthesizes NO extra message for this event; it only stamps
   * the dedup marker on the reconstructed tool result. Emitted at most once
   * per (conversation, skill). Payload: { runId, toolCallId, skillName,
   * scope, tokens }.
   */
  "skill.activated": SkillActivatedPayload;
  "skill.suppression": SkillSuppressionPayload;
  "context.assembled": ContextAssembledPayload & { runId: string };
  /**
   * Emitted when a model call is rejected for exceeding the context window
   * and the engine re-windows history with a tighter budget before retrying.
   * Payload: { runId, attempt, previousMessageCount, errorMessage }.
   */
  "context.overflow_recovery": ContextOverflowRecoveryPayload;
  "connector.installed": ConnectorInstalledPayload;
  "connector.uninstalled": ConnectorUninstalledPayload;
  /**
   * Per-principal connection state change for a remote URL connector.
   * Payload: { wsId, serverName, principalId, state, authorizationUrl? }.
   * Workspace-scoped connectors emit one event stream (principalId = "_workspace");
   * member-scoped connectors emit one stream per active member.
   */
  "connection.state_changed": ConnectionStateChangedPayload;
  "connector.health": ConnectorHealthPayload;
  /**
   * An app server sent a notification a host relays to the server's views
   * (`RELAYED_SERVER_NOTIFICATIONS`), after coalescing. Forwarded to SSE as
   * itself, scoped to the workspace; the web shell posts `{ method, params }`
   * verbatim to that server's iframes. Payload: { server, workspaceId, method,
   * params? }.
   */
  "server.notification": ServerNotificationPayload;
  "conversation.title": ConversationTitlePayload;
  "config.changed": ConfigChangedPayload;
  "skill.created": SkillCreatedPayload;
  "skill.updated": SkillUpdatedPayload;
  "skill.deleted": SkillDeletedPayload;
  "bridge.tool.call": BridgeToolCallPayload;
  "bridge.tool.done": BridgeToolDonePayload;
  /**
   * A notification a connector emitted reached a workspace's inbox. Emitted
   * once per item, after the durable write — the inbox is the guarantee and
   * everything downstream of it is best-effort. Payload:
   * { workspaceId, id, seq, source, name, level, title, subject?, receivedAt }.
   */
  "notification.created": NotificationCreatedPayload;
  /**
   * A route target delivered. The ledger row on the item changed after
   * `notification.created` announced it, so without this a browser holding
   * that item shows a delivery that never updates until an unrelated later
   * frame happens to arrive. Payload:
   * { workspaceId, id, seq, routeId, target, attempts }.
   */
  "notification.delivered": NotificationDeliveredPayload;
  /**
   * A route target reached a terminal outcome that is not delivery — refused,
   * skipped for a departed author, or out of retries. Carries the same
   * coordinates as the delivery-ledger row it accompanies, so a failed post is
   * visible instead of silent. Payload:
   * { workspaceId, id, seq, routeId, target, outcome, attempts, error }.
   */
  "notification.delivery_failed": NotificationDeliveryFailedPayload;
  "http.error": HttpErrorPayload;
  "audit.auth_failure": AuthFailurePayload;
  "audit.permission_denied": PermissionDeniedPayload;
  /**
  /**
   * A secret held in the credential store was revealed to a caller — presented
   * as a header, exchanged at a token endpoint, handed to a provider SDK.
   * Payload: { scope, key, caller, purpose } plus `workspaceId` / `userId` when
   * the scope has one. NEVER the value.
   *
   * Emitted on the reveal rather than on the read that produced it, so the log
   * records secrets that were used and not secrets that were probed for
   * presence — and at most once per read, so a long-lived `fetch` wrapper
   * presenting one secret does not write a line per request.
   */
  "audit.credential_read": CredentialReadPayload;
  /**
   * A stored secret claimed to be sealed and could not be opened — no sealing
   * key configured, no ring entry matching its `kid`, or a failed
   * authentication tag. Payload: { scope, key, reason, wantedKid? } plus
   * `workspaceId` / `userId` when the scope has one. NEVER the value: the bytes
   * that failed to open are still the ciphertext of a live credential.
   *
   * A tag failure is either tampering or a misconfigured key, and both belong
   * on the same stream the reads go to. `wantedKid` is a MAC over a constant,
   * so naming it discloses nothing about the key behind it while letting an
   * operator tell "the outgoing key was dropped too early" from "this file came
   * from somewhere else".
   */
  "audit.credential_seal_failure": CredentialSealFailurePayload;
  /**
   * An unattended dispatch — one tool call made with no session, as a named
   * principal, from stored configuration — reached the door. Emitted once per
   * call, whatever the outcome, including the ones that never touch a registry:
   * the point of the line is that the attempt is on the record, so a dispatch
   * nobody watched is still something an operator can read back. Payload:
   * { principalId, workspaceId, tool, reason, outcome, classification?, ms }.
   */
  "audit.unattended_dispatch": UnattendedDispatchPayload;
  /**
   * A call to a connector tool its catalog entry declares in `admin_tools`
   * reached the role gate. Emitted once per call, admitted or refused, from
   * the gate every door runs, so no door and no connector has to remember to
   * write it. The connector is never told who called; this line is the only
   * record that names them. Payload: `AdminToolCallPayload`.
   */
  "audit.admin_tool_call": AdminToolCallPayload;
  /**
   * The credential store finished its boot reconcile. Payload:
   * { sealed, strictPlaintextRefusal } — whether a sealing key is configured,
   * and whether the sweep saw enough to refuse plaintext from now on. Emitted
   * once per boot; nothing after it changes either field.
   */
  "credential_store.reconciled": CredentialStoreReconciledPayload;
}
