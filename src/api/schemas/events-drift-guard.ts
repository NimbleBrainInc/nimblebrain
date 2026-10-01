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

/** Fails to compile (TS2344), naming the offending keys, unless `_T` is `never`. */
type AssertNone<_T extends never> = unknown;

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

/**
 * The keys of a stream's catalog, less its server-built frames, that do not
 * restate an engine event: a key the engine has no event for, or one whose
 * payload has drifted from its engine event's.
 */
type Unrestated<Catalog, ServerBuilt> = {
  [K in Exclude<keyof Catalog, ServerBuilt>]: K extends keyof EngineEventPayloads
    ? Restates<EngineEventPayloads[K], Catalog[K]> extends true
      ? never
      : K
    : K;
}[Exclude<keyof Catalog, ServerBuilt>];

// GET /v1/events: every engine event the SSE route table forwards.
export type DriftWorkspaceStream = AssertNone<Unrestated<Wire.WorkspaceStreamEvents, "heartbeat">>;

// GET /v1/conversations/:id/events: every engine run event the RunBus forwards.
export type DriftConversationStream = AssertNone<
  Unrestated<Wire.ConversationStreamEvents, Wire.TurnFrame | Wire.ControlFrame>
>;
