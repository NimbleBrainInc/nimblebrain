import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/** Cache compiled validators by schema reference (schemas are stable at runtime). */
const cache = new WeakMap<object, ReturnType<typeof ajv.compile>>();

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; errors: ErrorObject[] };

/**
 * Validate tool input against its declared JSON Schema.
 *
 * Every non-empty schema is compiled and run — we don't try to guess which
 * keywords matter. A previous keyword-allowlist heuristic would silently
 * skip schemas that only declared `additionalProperties: false`,
 * `minProperties`, etc.; a soundness trap now that this helper runs on
 * every `defineInProcessApp` tool call. Compilation is cheap and cached
 * per schema reference, so always running is essentially free.
 *
 * Truly empty schemas (`{}`) still early-return valid — AJV would accept
 * anything anyway, and it saves a round-trip.
 */
export function validateToolInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationResult {
  if (Object.keys(schema).length === 0) {
    return { valid: true };
  }

  let validate = cache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    cache.set(schema, validate);
  }

  if (validate(input)) {
    return { valid: true };
  }

  const errors = validate.errors ?? [];
  const error = errors.map((e) => `${e.instancePath || "(root)"}: ${e.message}`).join("; ");

  return { valid: false, error, errors };
}
