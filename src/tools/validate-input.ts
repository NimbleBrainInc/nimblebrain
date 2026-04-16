import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/** Cache compiled validators by schema reference (schemas are stable at runtime). */
const cache = new WeakMap<object, ReturnType<typeof ajv.compile>>();

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; errors: ErrorObject[] };

/**
 * Validate tool input against its declared JSON Schema.
 * Returns valid for empty/missing schemas (tools that accept anything).
 * Compiled validators are cached per schema object reference.
 */
export function validateToolInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationResult {
  // Skip validation for schemas with no meaningful constraints
  if (!schema.properties && !schema.required && !schema.allOf && !schema.oneOf && !schema.anyOf) {
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
