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
//     `src/tools/platform/schemas/<source>.ts`.
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

import { Type } from "@sinclair/typebox";

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
