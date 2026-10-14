/**
 * JSON Schema checks for a task's `inputSchema` and `outputSchema`: that
 * an author's schema is one, that a run's input matches it, and that a run's
 * deliverable parses and matches it.
 *
 * The schemas are caller-authored, so each is compiled when it is written
 * (create, update, an inline one-off) and a schema that does not compile is
 * refused there rather than at the first run.
 */

import Ajv, { type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/** Compiled validators, by schema text: stored definitions are re-read per request. */
const compiled = new Map<string, ValidateFunction>();

/** The most compiled schemas kept; past it the oldest is dropped. */
const MAX_COMPILED = 256;

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const hit = compiled.get(key);
  if (hit) return hit;
  const validate = ajv.compile(schema);
  if (compiled.size >= MAX_COMPILED) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(key, validate);
  return validate;
}

/** Throw a readable error when `schema` is not a JSON Schema that compiles. */
export function assertJsonSchema(schema: unknown, field: string): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${field} must be a JSON Schema object`);
  }
  try {
    validatorFor(schema as Record<string, unknown>);
  } catch (err) {
    throw new Error(
      `${field} is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Whether `value` matches `schema`, with one message per mismatch when it does not. */
export function checkAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: true } | { valid: false; errors: string[] } {
  const validate = validatorFor(schema);
  if (validate(value)) return { valid: true };
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "(root)"}: ${e.message ?? "does not match"}`,
  );
  return { valid: false, errors: errors.length > 0 ? errors : ["(root): does not match"] };
}

/**
 * Parse a model's final answer as JSON: the whole text, or the body of a
 * fenced code block when the answer wraps it in one. Null when neither parses.
 */
export function parseJsonDeliverable(output: string): { value: unknown } | null {
  const text = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  for (const candidate of fenced ? [fenced[1] ?? "", text] : [text]) {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // try the next form
    }
  }
  return null;
}
