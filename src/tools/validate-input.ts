import type { ErrorObject, ValidateFunction } from "ajv";
import { log } from "../observability/log.ts";
import { compileJsonSchema } from "../util/json-schema-dialect.ts";

/** Cache compiled validators by schema reference (schemas are stable at runtime). */
const cache = new WeakMap<object, ValidateFunction | { uncompilable: string }>();

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
 * keyword) is logged once and never throws. By default its input is refused
 * with a readable error: for a platform tool this check is the only gate
 * before a handler that trusts its typed input. A caller whose server checks
 * its own input passes `uncompilable: "pass"` to let the call through instead
 * (the engine, for a connector's schema), since a refusal there would fail
 * every call to the tool, which no change of arguments could fix.
 */
export function validateToolInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
  options: { uncompilable?: "refuse" | "pass" } = {},
): ValidationResult {
  if (Object.keys(schema).length === 0) {
    return { valid: true };
  }

  let validate = cache.get(schema);
  if (!validate) {
    try {
      validate = compileJsonSchema(schema);
    } catch (err) {
      validate = { uncompilable: err instanceof Error ? err.message : String(err) };
      log.warn("[tools] input_schema.uncompilable", {
        schemaDialect: typeof schema.$schema === "string" ? schema.$schema : undefined,
        error: validate.uncompilable,
      });
    }
    cache.set(schema, validate);
  }
  if (typeof validate !== "function") {
    if (options.uncompilable === "pass") return { valid: true };
    return {
      valid: false,
      error: `the tool's input schema does not compile: ${validate.uncompilable}`,
      errors: [],
    };
  }

  if (validate(input)) {
    return { valid: true };
  }

  const errors = validate.errors ?? [];
  const error = errors.map((e) => `${e.instancePath || "(root)"}: ${e.message}`).join("; ");

  return { valid: false, error, errors };
}
