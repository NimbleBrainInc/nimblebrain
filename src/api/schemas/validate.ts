// ---------------------------------------------------------------------------
// Schema validation helpers for REST handlers.
//
// Uses TypeBox's `Value.Check` against schemas declared in `./rest.ts`.
// On failure, returns the first failing path + message — the same format
// that `validateToolInput` (AJV) produces, so error messages stay
// consistent across the validate-tool-input and validate-rest-body paths.
// ---------------------------------------------------------------------------

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface SchemaValidationResult {
  ok: boolean;
  /** First failure path + message, or null on success. */
  reason: string | null;
}

/**
 * Validate `value` against `schema`. Returns `{ ok: true }` on pass, or
 * `{ ok: false, reason }` with a one-line summary of the first failing
 * field on rejection. Stringifies the JSON Pointer path the same way the
 * AJV-backed validator does (`(root)` when path is empty).
 */
export function validateAgainst(value: unknown, schema: TSchema): SchemaValidationResult {
  if (Value.Check(schema, value)) return { ok: true, reason: null };
  const errors = [...Value.Errors(schema, value)];
  const first = errors[0];
  if (!first) return { ok: false, reason: "Unknown validation failure" };
  return { ok: false, reason: `${first.path || "(root)"}: ${first.message}` };
}
