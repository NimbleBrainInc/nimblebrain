// Shared TypeBox helpers for platform tool schemas. Co-located with the
// per-source schema modules so they share one definition of "string enum
// in the AJV-friendly form" — `Type.Union([Type.Literal(...)])` produces
// `anyOf`-of-`const` which doesn't match the legacy `{type, enum: [...]}`
// shape that older external clients and `additionalProperties: false`
// validators expect. These helpers emit `enum` directly while keeping
// the literal-narrowed TS type via `Type.Unsafe<T>`.

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
