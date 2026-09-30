/**
 * Compile-time drift guard for the SSE event types in `events.ts`.
 *
 * `events.ts` restates each engine event a stream sends, because it must import
 * nothing outside its directory to be emitted into the web tree. Each
 * restatement is pinned here to its `EngineEventPayloads` entry: the same keys
 * both ways, and the engine payload assignable to the wire type once its
 * `undefined` values are dropped, which is what `JSON.stringify` sends. A field
 * added, removed or retyped on either side fails `bun run check` with TS2344.
 *
 * Zero runtime emission: type aliases erase, and this module compiles empty.
 */

import type { ConnectionState } from "../../connectors/runtime/connection.ts";
import type { ConnectorUiMeta, PlacementDeclaration } from "../../connectors/runtime/types.ts";
import type { ResourceLinkInfo } from "../../engine/content-helpers.ts";
import type {
  ContextAssembledSource,
  EngineEventPayloads,
  SkillsLoadedEntry,
} from "../../engine/schemas/events.ts";
import type * as Wire from "./events.ts";

/** Every key across the members of a union. */
type Keys<T> = T extends unknown ? keyof T : never;

/** A payload as JSON carries it: a key whose value is `undefined` is not sent. */
type Json<T> = T extends unknown ? { [K in keyof T]: Exclude<T[K], undefined> } : never;

/** `true` when `Wire` restates `Source`: the same keys, and `Source` fits `Wire`. */
type Restates<Source, WireT> = [Exclude<Keys<Source>, Keys<WireT>>] extends [never]
  ? [Exclude<Keys<WireT>, Keys<Source>>] extends [never]
    ? [Json<Source>] extends [WireT]
      ? true
      : false
    : false
  : false;

/** Fails to compile (TS2344) unless `_T` is `true`. */
type AssertTrue<_T extends true> = unknown;

/** The engine payload a stream sends under `K`. */
type Engine<K extends keyof EngineEventPayloads> = EngineEventPayloads[K];

// Exported only to satisfy `noUnusedLocals`; the constraint is the check.

// Shared shapes.
export type DriftConnectionState = AssertTrue<Restates<ConnectionState, Wire.ConnectionState>>;
export type DriftPlacement = AssertTrue<Restates<PlacementDeclaration, Wire.PlacementDeclaration>>;
export type DriftConnectorUiMeta = AssertTrue<Restates<ConnectorUiMeta, Wire.ConnectorUiMeta>>;
export type DriftResourceLink = AssertTrue<Restates<ResourceLinkInfo, Wire.ResourceLinkInfo>>;
export type DriftSkillsLoadedEntry = AssertTrue<
  Restates<SkillsLoadedEntry, Wire.SkillsLoadedEntry>
>;
export type DriftContextSource = AssertTrue<
  Restates<ContextAssembledSource, Wire.ContextAssembledSource>
>;

// GET /v1/events: every engine event the SSE route table forwards.
export type DriftWsConnectorInstalled = AssertTrue<
  Restates<Engine<"connector.installed">, Wire.WorkspaceStreamEvents["connector.installed"]>
>;
export type DriftWsConnectorUninstalled = AssertTrue<
  Restates<Engine<"connector.uninstalled">, Wire.WorkspaceStreamEvents["connector.uninstalled"]>
>;
export type DriftWsConnectionStateChanged = AssertTrue<
  Restates<
    Engine<"connection.state_changed">,
    Wire.WorkspaceStreamEvents["connection.state_changed"]
  >
>;
export type DriftWsServerNotification = AssertTrue<
  Restates<Engine<"server.notification">, Wire.WorkspaceStreamEvents["server.notification"]>
>;
export type DriftWsConversationTitle = AssertTrue<
  Restates<Engine<"conversation.title">, Wire.WorkspaceStreamEvents["conversation.title"]>
>;
export type DriftWsConfigChanged = AssertTrue<
  Restates<Engine<"config.changed">, Wire.WorkspaceStreamEvents["config.changed"]>
>;
export type DriftWsSkillCreated = AssertTrue<
  Restates<Engine<"skill.created">, Wire.WorkspaceStreamEvents["skill.created"]>
>;
export type DriftWsSkillUpdated = AssertTrue<
  Restates<Engine<"skill.updated">, Wire.WorkspaceStreamEvents["skill.updated"]>
>;
export type DriftWsSkillDeleted = AssertTrue<
  Restates<Engine<"skill.deleted">, Wire.WorkspaceStreamEvents["skill.deleted"]>
>;
export type DriftWsBridgeToolCall = AssertTrue<
  Restates<Engine<"bridge.tool.call">, Wire.WorkspaceStreamEvents["bridge.tool.call"]>
>;
export type DriftWsBridgeToolDone = AssertTrue<
  Restates<Engine<"bridge.tool.done">, Wire.WorkspaceStreamEvents["bridge.tool.done"]>
>;
export type DriftWsNotificationCreated = AssertTrue<
  Restates<Engine<"notification.created">, Wire.WorkspaceStreamEvents["notification.created"]>
>;
export type DriftWsNotificationDelivered = AssertTrue<
  Restates<Engine<"notification.delivered">, Wire.WorkspaceStreamEvents["notification.delivered"]>
>;
export type DriftWsNotificationDeliveryFailed = AssertTrue<
  Restates<
    Engine<"notification.delivery_failed">,
    Wire.WorkspaceStreamEvents["notification.delivery_failed"]
  >
>;

// GET /v1/conversations/:id/events: every engine run event the RunBus forwards
// (every entry but `Wire.TurnFrame` and `Wire.ControlFrame`).
export type DriftConvChatStart = AssertTrue<
  Restates<Engine<"chat.start">, Wire.ConversationStreamEvents["chat.start"]>
>;
export type DriftConvRunStart = AssertTrue<
  Restates<Engine<"run.start">, Wire.ConversationStreamEvents["run.start"]>
>;
export type DriftConvRunDone = AssertTrue<
  Restates<Engine<"run.done">, Wire.ConversationStreamEvents["run.done"]>
>;
export type DriftConvRunError = AssertTrue<
  Restates<Engine<"run.error">, Wire.ConversationStreamEvents["run.error"]>
>;
export type DriftConvTextDelta = AssertTrue<
  Restates<Engine<"text.delta">, Wire.ConversationStreamEvents["text.delta"]>
>;
export type DriftConvReasoningDelta = AssertTrue<
  Restates<Engine<"reasoning.delta">, Wire.ConversationStreamEvents["reasoning.delta"]>
>;
export type DriftConvToolPreparing = AssertTrue<
  Restates<Engine<"tool.preparing">, Wire.ConversationStreamEvents["tool.preparing"]>
>;
export type DriftConvToolPreparingDone = AssertTrue<
  Restates<Engine<"tool.preparing.done">, Wire.ConversationStreamEvents["tool.preparing.done"]>
>;
export type DriftConvToolStart = AssertTrue<
  Restates<Engine<"tool.start">, Wire.ConversationStreamEvents["tool.start"]>
>;
export type DriftConvToolDone = AssertTrue<
  Restates<Engine<"tool.done">, Wire.ConversationStreamEvents["tool.done"]>
>;
export type DriftConvToolProgress = AssertTrue<
  Restates<Engine<"tool.progress">, Wire.ConversationStreamEvents["tool.progress"]>
>;
export type DriftConvToolPromoted = AssertTrue<
  Restates<Engine<"tool.promoted">, Wire.ConversationStreamEvents["tool.promoted"]>
>;
export type DriftConvToolReleased = AssertTrue<
  Restates<Engine<"tool.released">, Wire.ConversationStreamEvents["tool.released"]>
>;
export type DriftConvLlmDone = AssertTrue<
  Restates<Engine<"llm.done">, Wire.ConversationStreamEvents["llm.done"]>
>;
export type DriftConvLlmError = AssertTrue<
  Restates<Engine<"llm.error">, Wire.ConversationStreamEvents["llm.error"]>
>;
export type DriftConvSkillsLoaded = AssertTrue<
  Restates<Engine<"skills.loaded">, Wire.ConversationStreamEvents["skills.loaded"]>
>;
export type DriftConvContextAssembled = AssertTrue<
  Restates<Engine<"context.assembled">, Wire.ConversationStreamEvents["context.assembled"]>
>;
export type DriftConvContextOverflowRecovery = AssertTrue<
  Restates<
    Engine<"context.overflow_recovery">,
    Wire.ConversationStreamEvents["context.overflow_recovery"]
  >
>;
export type DriftConvConnectorSkillInjected = AssertTrue<
  Restates<
    Engine<"connector.skill.injected">,
    Wire.ConversationStreamEvents["connector.skill.injected"]
  >
>;
export type DriftConvSkillActivated = AssertTrue<
  Restates<Engine<"skill.activated">, Wire.ConversationStreamEvents["skill.activated"]>
>;
export type DriftConvSkillSuppression = AssertTrue<
  Restates<Engine<"skill.suppression">, Wire.ConversationStreamEvents["skill.suppression"]>
>;

// Every catalog entry that is not a frame the server builds itself is an engine
// event: a new entry needs a restatement check above.
export type DriftWorkspaceKeys = AssertTrue<
  [Exclude<keyof Wire.WorkspaceStreamEvents, "heartbeat" | keyof EngineEventPayloads>] extends [
    never,
  ]
    ? true
    : false
>;
export type DriftConversationKeys = AssertTrue<
  [
    Exclude<
      keyof Wire.ConversationStreamEvents,
      Wire.TurnFrame | Wire.ControlFrame | keyof EngineEventPayloads
    >,
  ] extends [never]
    ? true
    : false
>;
