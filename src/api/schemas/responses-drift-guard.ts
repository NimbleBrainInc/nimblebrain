/**
 * Compile-time drift guard for the REST response types.
 *
 * `responses.ts` imports nothing, so the web codegen emits it alone, and the
 * domain types a response carries are restated there. Each restatement is
 * pinned to its source below.
 *
 * `bun run check` compiles this file. If either side gains, loses, or changes a
 * field the other does not match, an alias fails with TS2344: update the type in
 * `responses.ts` alongside its source.
 *
 * Zero runtime emission: type aliases erase, and this module compiles empty.
 */

import type { PlacementEntry } from "../../connectors/runtime/types.ts";
import type { ContentBlock } from "../../engine/types.ts";
import type { FileEntry } from "../../files/types.ts";
import type { OrgRole } from "../../identity/types.ts";
import type { UserPreferences } from "../../identity/user.ts";
import type { CatalogModel } from "../../model/catalog.ts";
import type { ChatResult, ModelSlots, TurnUsage } from "../../runtime/types.ts";
import type { TokenUsage } from "../../usage/types.ts";
import type { WorkspaceRole } from "../../workspace/types.ts";
import type * as Wire from "./responses.ts";

/** Fails to compile (TS2344) when `_A` is not assignable to `B`. */
type AssertAssignable<_A extends B, B> = unknown;

/**
 * Fails to compile (TS2344) unless `_T` is `never`. Assignability alone lets an
 * optional field exist on one side only, so the key sets are compared too.
 */
type AssertNever<_T extends never> = unknown;

/**
 * `true` when `A` and `B` are identical: same fields, same optionality, same
 * types. Mutual assignability would let an optional field exist on one side.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile (TS2344) unless `_T` is `true`. */
type AssertTrue<_T extends true> = unknown;

// Exported only to satisfy `noUnusedLocals`; the constraint is the check.
export type DriftOrgRole = AssertTrue<Identical<Wire.OrgRole, OrgRole>>;
export type DriftWorkspaceRole = AssertTrue<Identical<Wire.WorkspaceRole, WorkspaceRole>>;
export type DriftUserPreferences = AssertTrue<Identical<Wire.UserPreferences, UserPreferences>>;
export type DriftModelSlots = AssertTrue<Identical<Wire.ModelSlots, ModelSlots>>;
export type DriftCatalogModel = AssertTrue<Identical<Wire.CatalogModel, CatalogModel>>;
export type DriftPlacementEntry = AssertTrue<Identical<Wire.PlacementEntry, PlacementEntry>>;
export type DriftFileEntry = AssertTrue<Identical<Wire.FileEntry, FileEntry>>;
export type DriftTokenUsage = AssertTrue<Identical<Wire.TokenUsage, TokenUsage>>;
export type DriftTurnUsage = AssertTrue<Identical<Wire.TurnUsage, TurnUsage>>;
export type DriftChatToolCall = AssertTrue<
  Identical<Wire.ChatToolCall, ChatResult["toolCalls"][number]>
>;

// `ChatResponse` is `ChatResult` with top-level token counts and a priced
// `usage`. A field added to `ChatResult` must be added to the response too.
export type DriftChatResultKeys = AssertNever<Exclude<keyof ChatResult, keyof Wire.ChatResponse>>;

// The MCP SDK's content union must fit the loose wire block (one direction:
// the wire type is a deliberate widening of an external union).
export type DriftToolContent = AssertAssignable<ContentBlock, Wire.ToolContentBlock>;
