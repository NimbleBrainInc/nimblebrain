// Shared TypeBox helpers for platform tool schemas. Co-located with the
// per-source schema modules so they share one definition of "string enum
// in the AJV-friendly form" — `Type.Union([Type.Literal(...)])` produces
// `anyOf`-of-`const` which doesn't match the legacy `{type, enum: [...]}`
// shape that older external clients and `additionalProperties: false`
// validators expect. These helpers emit `enum` directly while keeping
// the literal-narrowed TS type via `Type.Unsafe<T>`.
//
// ── When to use which form (policy) ──────────────────────────────────────
//
// USE `StringEnum`/`NumberEnum` (Type.Unsafe + JSON Schema `enum`):
//   - Schemas that AJV validates (`validateToolInput` in src/tools/),
//     i.e. every platform tool input under
//     `src/platform/schemas/<source>.ts`.
//   - Schemas advertised over the MCP `tools/list` wire to external
//     clients (Claude Code, Cursor, the agent itself). These clients
//     expect the standard `{type, enum: [...]}` JSON Schema form.
//
// USE `Type.Union([Type.Literal(...)])` (TypeBox-native):
//   - Schemas walked by TypeBox's `Value.Check` directly — bridge
//     postMessage envelopes (`web/src/bridge/schemas.ts`), SSE event
//     payloads (`src/engine/schemas/events.ts`). `Type.Unsafe` omits
//     the `Kind` discriminator that `Value.Check` requires; using
//     `StringEnum` here causes `error: Unknown type` at runtime.
//
// One-line rule: **schemas validated by AJV → StringEnum; schemas
// validated by TypeBox `Value.Check` → Union-of-Literal.**

import {
  type Static,
  type TObject,
  type TSchema,
  type TUnion,
  type TUnsafe,
  Type,
} from "@sinclair/typebox";

export function StringEnum<T extends string>(
  values: readonly T[],
  options: { description?: string } = {},
) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...options });
}

export function NumberEnum<T extends number>(
  values: readonly T[],
  options: { description?: string } = {},
) {
  return Type.Unsafe<T>({ type: "number", enum: [...values], ...options });
}

/** An optional field an update clears with `null` (src/platform/AGENTS.md §1.3). */
export function clearable<T extends TSchema>(schema: T, description: string) {
  return Type.Optional(Type.Union([schema, Type.Null()], { description }));
}

/**
 * A tool output that is one of several object shapes. MCP's 2025-11-25 revision
 * requires an output schema whose root is `type: "object"`, and the SDK server
 * rewraps any other root as `{ result: … }`, which the handler's
 * `structuredContent` then fails to match. The root `type` keeps the union
 * unwrapped on every revision.
 */
export function ObjectUnion<T extends TObject[]>(
  members: [...T],
): TUnsafe<Static<TUnion<T>>> & { type: "object" } {
  return { ...Type.Unsafe<Static<TUnion<T>>>({ anyOf: members }), type: "object" as const };
}
