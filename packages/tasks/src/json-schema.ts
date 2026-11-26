/**
 * JSON Schemas an author supplies (`inputSchema`, `outputSchema`): that one
 * compiles, that a run's input matches it, and that a deliverable parses and
 * matches it. Each schema compiles under the dialect its `$schema` names
 * (draft-07 when it names none), so an author's draft-07 schema keeps working.
 */

import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

const OPTIONS = { allErrors: true, strict: false, addUsedSchema: false } as const;
const DIALECTS: Record<string, () => Ajv> = {
  "https://json-schema.org/draft/2020-12/schema": () => new Ajv2020(OPTIONS),
  "https://json-schema.org/draft/2019-09/schema": () => new Ajv2019(OPTIONS),
};
const instances = new Map<string, Ajv>();

function ajvFor(schema: Record<string, unknown>): Ajv {
  const uri = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : "";
  const key = DIALECTS[uri] ? uri : "draft-07";
  let ajv = instances.get(key);
  if (!ajv) {
    ajv = DIALECTS[uri]?.() ?? new Ajv(OPTIONS);
    instances.set(key, ajv);
  }
  return ajv;
}

/** Compiled validators by schema text; past the cap the oldest is dropped. */
const compiled = new Map<string, ValidateFunction>();
const MAX_COMPILED = 256;

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const hit = compiled.get(key);
  if (hit) return hit;
  const validate = ajvFor(schema).compile(schema);
  if (compiled.size >= MAX_COMPILED) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(key, validate);
  return validate;
}

/** Why `schema` is not a JSON Schema that compiles, or null. */
export function schemaProblem(schema: Record<string, unknown>, field: string): string | null {
  try {
    validatorFor(schema);
    return null;
  } catch (err) {
    return `${field} is not a valid JSON Schema: ${err instanceof Error ? err.message : err}`;
  }
}

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

/** A final answer parsed as JSON: the whole text, or a fenced code block's body. */
export function parseJsonDeliverable(output: string): { value: unknown } | null {
  const text = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  for (const candidate of fenced ? [fenced[1] ?? "", text] : [text]) {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // the next form
    }
  }
  return null;
}

/** The most a run's input may be, serialized (the work spec's bound). */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

/** Why `input` cannot be a run's input for a definition with `inputSchema`, or null. */
export function runInputProblem(
  inputSchema: Record<string, unknown> | undefined,
  input: unknown,
): string | null {
  if (input === undefined) {
    if (inputSchema && !checkAgainstSchema(inputSchema, null).valid) {
      return "the task takes an input matching its inputSchema; none was given";
    }
    return null;
  }
  const size = Buffer.byteLength(JSON.stringify(input) ?? "", "utf-8");
  if (size > MAX_RUN_INPUT_BYTES) {
    return `input is ${size} bytes serialized; a run's input may be at most ${MAX_RUN_INPUT_BYTES}`;
  }
  if (!inputSchema) return null;
  const verdict = checkAgainstSchema(inputSchema, input);
  return verdict.valid
    ? null
    : `input does not match the task's inputSchema: ${verdict.errors.join("; ")}`;
}
