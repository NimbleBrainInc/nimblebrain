/**
 * Schema-aware input coercion. Runs before `validateToolInput` at every
 * tool-call entry point.
 *
 * Why this exists: the wire format for streaming tool calls historically
 * delivered `function_call.arguments` as a JSON-encoded string (OpenAI's
 * legacy shape). Models trained against that convention sometimes
 * overgeneralize and stringify *nested* object/array values too — emitting
 * `{ manifest: "{\"name\":\"foo\"}" }` instead of `{ manifest: { name: "foo" }}`.
 *
 * The engine and `inbound-fit` already JSON-parse the *outer* `input` when
 * it arrives as a string. This helper extends the same forgiveness one
 * level deeper: schema-driven, not depth-limited. We use the schema as a
 * parsing oracle — for any property declared as `object` or `array`, if
 * the actual value is a string, attempt `JSON.parse` once and substitute
 * the parsed value. Recurse into the parsed result so deeply nested
 * misencodings unwind in one pass.
 *
 * Non-parseable strings (and strings where the schema didn't expect an
 * object/array) pass through unchanged — the validator reports them with
 * its content-aware error. Non-string values are untouched.
 *
 * Idempotent: a properly shaped input survives unchanged. Safe to call at
 * multiple boundaries without amplification.
 *
 * Why not AJV's `coerceTypes`: AJV only coerces between scalar types
 * (string ↔ number, etc.). It does not parse string-as-JSON into objects
 * or arrays. This helper fills exactly that gap.
 */

type Schema = Record<string, unknown> | undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True iff the schema declares a single concrete type matching `target`. */
function declaresType(schema: Schema, target: "object" | "array"): boolean {
  if (!schema) return false;
  const t = schema.type;
  if (t === target) return true;
  if (Array.isArray(t) && t.includes(target)) return true;
  return false;
}

/** Try to parse a string as JSON; return undefined on failure. */
function tryJsonParse(s: string): unknown {
  // Cheap sniff: the model encodes objects as "{...}" and arrays as "[...]".
  // Anything else (a plain string the schema rejects on its own merits) is
  // not our responsibility to recover.
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Coerce one value against one sub-schema. Recurses through nested objects,
 * array items, and `oneOf`/`anyOf` alternatives. Returns the (possibly new)
 * value — callers should rebind, not mutate.
 */
function coerceValue(value: unknown, schema: Schema): unknown {
  if (!schema) return value;

  // String → object/array recovery via schema-declared expected type.
  if (typeof value === "string") {
    const wantObject = declaresType(schema, "object");
    const wantArray = declaresType(schema, "array");
    if (wantObject || wantArray) {
      const parsed = tryJsonParse(value);
      if (parsed !== undefined) {
        // Recurse so a nested misencoding inside the just-parsed value
        // also unwinds. The `parsed` shape may itself need further
        // coercion (object whose property is also string-encoded).
        return coerceValue(parsed, schema);
      }
      // Parse failed — leave as string. Validator will surface the
      // content-aware error ("must be object", "must be array").
      return value;
    }
    return value;
  }

  // Walk into objects: coerce each declared property by its sub-schema.
  if (isPlainObject(value) && declaresType(schema, "object")) {
    const properties = schema.properties as Record<string, Schema> | undefined;
    if (!properties) return value;
    let mutated: Record<string, unknown> | undefined;
    for (const key of Object.keys(value)) {
      const subSchema = properties[key];
      if (!subSchema) continue;
      const coerced = coerceValue(value[key], subSchema);
      if (coerced !== value[key]) {
        if (!mutated) mutated = { ...value };
        mutated[key] = coerced;
      }
    }
    return mutated ?? value;
  }

  // Walk into arrays: coerce each element by `items`.
  if (Array.isArray(value) && declaresType(schema, "array")) {
    const items = schema.items as Schema;
    if (!items) return value;
    let mutated: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const coerced = coerceValue(value[i], items);
      if (coerced !== value[i]) {
        if (!mutated) mutated = [...value];
        mutated[i] = coerced;
      }
    }
    return mutated ?? value;
  }

  return value;
}

/**
 * Deep-coerce `input` against `schema` so nested string-encoded objects
 * and arrays (a model misemission we've seen in production with both
 * Sonnet and Opus 4.7) survive validation.
 *
 * Always returns a `Record<string, unknown>`. If the top-level coerce
 * doesn't yield an object (input was something other than a string-
 * encoded top-level object), returns the input unchanged — the validator
 * decides what to do with it.
 */
export function coerceInputForSchema(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const coerced = coerceValue(input, schema);
  return isPlainObject(coerced) ? coerced : input;
}
