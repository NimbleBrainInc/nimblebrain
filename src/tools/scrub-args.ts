/**
 * Outbound argument scrubbing for MCP tool calls.
 *
 * Runs in `McpSource.execute()` between the model's emitted args and the
 * upstream `callTool` dispatch. Strips top-level properties whose value is a
 * "no-op for an optional field" — empty strings, nil UUIDs, empty arrays,
 * empty objects on properties the schema doesn't require.
 *
 * Why this exists: models routinely emit placeholder values for *optional*
 * fields they don't intend to use ("00000000-0000-0000-0000-000000000000"
 * for a `format: "uuid"` cursor, `""` for a date filter). Some upstream APIs
 * treat these as real values and reject the request with HTTP 400 rather
 * than ignoring them. Stripping at the wire is functionally equivalent to
 * the model having omitted the field.
 *
 * Scope:
 *  - Top-level only. The misemission pattern is at top-level and walking
 *    deep doubles the test surface for no observed benefit.
 *  - Optional fields only. Required fields pass through unchanged — the
 *    upstream API decides what's acceptable for those.
 *  - Schema-declared properties only. Unknown keys pass through unchanged
 *    (validator handles `additionalProperties: false` separately).
 *  - We do NOT strip values that equal `propSchema.default`. Real defaults
 *    on vendor schemas (e.g. `limit: 1000`) are meaningful; stripping them
 *    would change semantics.
 *
 * Idempotent. Pure. No side effects.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface ScrubResult {
  /** Args with no-op optional fields removed. */
  args: Record<string, unknown>;
  /** Property names that were dropped. For telemetry/debug only. */
  stripped: string[];
}

export function scrubArgsForDispatch(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): ScrubResult {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((schema.required as string[] | undefined) ?? []);

  const out: Record<string, unknown> = {};
  const stripped: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!isPlainObject(propSchema)) {
      out[key] = value;
      continue;
    }
    if (required.has(key)) {
      out[key] = value;
      continue;
    }
    if (isNoOpForSchema(value, propSchema)) {
      stripped.push(key);
      continue;
    }
    out[key] = value;
  }

  return { args: out, stripped };
}

function isNoOpForSchema(value: unknown, propSchema: Record<string, unknown>): boolean {
  const type = propSchema.type as string | undefined;
  const format = propSchema.format as string | undefined;

  if (type === "string") {
    if (value === "") return true;
    if (format === "uuid" && value === NIL_UUID) return true;
    return false;
  }

  if (type === "array" && Array.isArray(value) && value.length === 0) {
    return true;
  }

  if (type === "object" && isPlainObject(value) && Object.keys(value).length === 0) {
    return true;
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
