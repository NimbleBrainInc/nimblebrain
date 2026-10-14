import type { ErrorObject, ValidateFunction } from "ajv";
import { log } from "../observability/log.ts";
import { compileJsonSchema } from "../util/json-schema-dialect.ts";

/** A schema that does not compile: its calls pass through to the server. */
const UNCOMPILABLE = "uncompilable";

/** Cache compiled validators by schema reference (schemas are stable at runtime). */
const cache = new WeakMap<object, ValidateFunction | typeof UNCOMPILABLE>();

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
 *
 * A schema that does not compile (an unknown `$schema` dialect, a malformed
 * keyword) is logged once and its input passes as valid. The schema is the
 * server's, and the server checks its own input; refusing here would fail
 * every call to the tool, which no change of arguments could fix, and a throw
 * would end the run.
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
    try {
      validate = compileJsonSchema(schema);
    } catch (err) {
      validate = UNCOMPILABLE;
      log.warn("[tools] input_schema.uncompilable", {
        schemaDialect: typeof schema.$schema === "string" ? schema.$schema : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    cache.set(schema, validate);
  }
  if (validate === UNCOMPILABLE) {
    return { valid: true };
  }

  if (validate(input)) {
    return { valid: true };
  }

  const errors = validate.errors ?? [];
  const error = errors.map((e) => `${e.instancePath || "(root)"}: ${e.message}`).join("; ");

  return { valid: false, error, errors };
}
