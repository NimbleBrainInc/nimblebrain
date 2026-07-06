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
 * The same forgiveness extends one rung further to scalars: a model that
 * stringifies a number or boolean ("5", "true") for a param the schema types
 * as number/integer/boolean has its value recovered too. Coercion only fires
 * when the schema can't already accept a string, so a legitimately-string
 * param is never retyped.
 *
 * Non-parseable strings (and strings where the schema didn't expect an
 * object/array/number/boolean) pass through unchanged — the validator reports
 * them with its content-aware error. Non-string values are untouched.
 *
 * Idempotent: a properly shaped input survives unchanged. Safe to call at
 * multiple boundaries without amplification.
 *
 * Why not AJV's `coerceTypes`: it does not parse string-as-JSON into objects
 * or arrays (the original gap this helper fills), and its scalar coercion is
 * loose and mutating (`[]`↔scalar, `""`→0). Owning coercion here keeps it
 * schema-aware and conservative — we recover a clean misencoding and leave
 * anything ambiguous for the validator, rather than globally retyping inputs.
 *
 * ## Union schemas (`anyOf` / `oneOf`)
 *
 * Pydantic v2 encodes `Optional[T]` / `T | None` as
 * `{ anyOf: [{ type: <T-shape> }, { type: "null" }] }` — the canonical
 * shape for any optional structural parameter on a FastMCP bundle. We
 * resolve such unions before coercing: `null` branches carry no
 * structural shape, so we drop them; what remains is the effective
 * sub-schema. For the dominant `T | null` case this collapses to a single
 * concrete branch and the rest of the coercer operates as if the property
 * had been declared with a plain `type` from the start.
 *
 * Unions with two or more structural branches (rare; e.g. `list | dict`, or
 * any union that also includes a `string` branch) pass through unchanged —
 * we deliberately do not guess. Coercion's premise is that a stringified
 * value is a misencoding, which only holds when the schema can't accept a
 * string; a union that accepts a string accepts the value as-is, so coercing
 * it would silently change a legitimate value's type. The validator
 * adjudicates. Disambiguation can be added additively if a real bundle ever
 * ships such a param.
 *
 * `allOf` and `$ref` are out of scope. A property declared with either
 * passes through unchanged at that level — the validator still gets to
 * speak. The bug class this helper solves (`Optional[list[...]]` /
 * `Optional[dict[...]]` on FastMCP bundles) does not require them.
 */

type Schema = Record<string, unknown> | undefined;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonType = "object" | "array" | "number" | "integer" | "boolean" | "string";

/** True iff the (effective) schema declares a concrete type matching `target`. */
function declaresType(schema: Schema, target: JsonType): boolean {
  if (!schema) return false;
  const t = schema.type;
  if (t === target) return true;
  if (Array.isArray(t) && t.includes(target)) return true;
  return false;
}

/**
 * Recover a stringified scalar against a schema that declares a numeric or
 * boolean type — the same model-misencoding class as the object/array case,
 * one rung down: a model emits `"5"` or `"true"` for a param typed as
 * number/integer/boolean. Returns the coerced primitive, or `undefined` when
 * the string isn't a clean match (leave it for the validator's content-aware
 * error rather than guess). A schema that also accepts `string` is handled by
 * the caller — we never coerce a value the schema would take as-is.
 */
function coerceScalarString(
  value: string,
  schema: Record<string, unknown>,
): number | boolean | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (declaresType(schema, "integer")) {
    const n = Number(trimmed);
    return Number.isInteger(n) ? n : undefined;
  }
  if (declaresType(schema, "number")) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  if (declaresType(schema, "boolean")) {
    // Lowercase JSON literals only, deliberately. Python-cased "True"/"False"
    // would recover too, but we haven't observed it — keep the match tight and
    // let anything else fall to the validator. Widen only if it shows up.
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return undefined;
  }
  return undefined;
}

/**
 * Surface the structural sub-schemas reachable from `schema` through
 * `anyOf` / `oneOf`. `null` branches are dropped — a non-null value
 * can't coerce into a null, so they contribute nothing to a coercion
 * decision. A schema with a direct `type` is itself the structural
 * branch: composition and direct typing don't combine in the schemas
 * we accept (and AJV would already validate against both, so this
 * matches its precedence).
 *
 * Returns `[]` if no structural branch is reachable from this node
 * (e.g. a leaf with only `$ref`, or an `allOf` we don't unfold).
 */
function structuralBranches(schema: Schema): Array<Record<string, unknown>> {
  if (!schema) return [];
  if (schema.type !== undefined) return [schema];
  const composed: unknown[] = [];
  if (Array.isArray(schema.anyOf)) composed.push(...schema.anyOf);
  if (Array.isArray(schema.oneOf)) composed.push(...schema.oneOf);
  if (composed.length === 0) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const branch of composed) {
    if (!isPlainObject(branch)) continue;
    for (const sub of structuralBranches(branch)) {
      if (sub.type === "null") continue;
      out.push(sub);
    }
  }
  return out;
}

/**
 * Resolve a possibly-union schema to the concrete sub-schema we'll coerce
 * against. For `T | null` (Pydantic's canonical `Optional[T]` shape) this
 * drops the `null` branch and collapses to T. A schema that's already
 * concrete is returned unchanged.
 *
 * When two or more structural branches remain (e.g. `str | list`, `list |
 * dict`) we deliberately do NOT pick one. Coercion's premise is that a
 * stringified value is a misencoding — which only holds when the schema
 * can't accept a string. A union that includes a `string` branch accepts
 * the string as-is, so coercing it would silently change a legitimate
 * value's type. Return the original union and let the validator adjudicate;
 * the caller's pass-through then leaves the value untouched. Disambiguation
 * can be added additively if a real bundle ever ships such a param.
 */
function effectiveSchemaFor(schema: Schema): Schema {
  if (!schema || schema.type !== undefined) return schema;
  const branches = structuralBranches(schema);
  return branches.length === 1 ? branches[0] : schema;
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
 * Coerce one value against one sub-schema. Recurses through nested
 * objects (via `properties`) and array items (via `items`); union-typed
 * sub-schemas are resolved to their effective structural branch up
 * front, so the property/items walk below sees a concrete `type` the
 * same as a plainly-declared schema would.
 *
 * Returns the (possibly new) value — callers should rebind, not mutate.
 */
function coerceValue(value: unknown, schema: Schema): unknown {
  if (!schema) return value;

  // Collapse a single-structural-branch union to that branch (dropping
  // `null`). For Pydantic `Optional[T]` this resolves the canonical
  // `anyOf: [{type: T}, {type: null}]` to the T branch before the rest of
  // the function runs; multi-branch unions pass through unchanged.
  const effective = effectiveSchemaFor(schema);
  if (!effective) return value;

  if (typeof value === "string") return coerceString(value, effective);
  if (isPlainObject(value) && declaresType(effective, "object")) {
    return coerceObjectProperties(value, effective);
  }
  if (Array.isArray(value) && declaresType(effective, "array")) {
    return coerceArrayItems(value, effective);
  }
  return value;
}

/** Recover a string into the object/array/scalar type its schema declares; pass through otherwise. */
function coerceString(value: string, effective: Record<string, unknown>): unknown {
  // String → object/array recovery via schema-declared expected type.
  const wantObject = declaresType(effective, "object");
  const wantArray = declaresType(effective, "array");
  if (wantObject || wantArray) {
    const parsed = tryJsonParse(value);
    if (parsed !== undefined) {
      // Recurse so a nested misencoding inside the just-parsed value
      // also unwinds. The `parsed` shape may itself need further
      // coercion (object whose property is also string-encoded).
      return coerceValue(parsed, effective);
    }
    // Parse failed — leave as string. Validator will surface the
    // content-aware error ("must be object", "must be array").
    return value;
  }
  // String → number/boolean recovery. Only when the schema can't already
  // accept a string (a `string` or `string | number` param takes the value
  // as-is, so coercing it would change a legitimate value's type).
  if (!declaresType(effective, "string")) {
    const scalar = coerceScalarString(value, effective);
    if (scalar !== undefined) return scalar;
  }
  return value;
}

/** Walk an object, coercing each declared property by its sub-schema; copies only when something changed. */
function coerceObjectProperties(
  value: Record<string, unknown>,
  effective: Record<string, unknown>,
): unknown {
  const properties = effective.properties as Record<string, Schema> | undefined;
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

/** Walk an array, coercing each element by `items`; copies only when something changed. */
function coerceArrayItems(value: unknown[], effective: Record<string, unknown>): unknown {
  const items = effective.items as Schema;
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
