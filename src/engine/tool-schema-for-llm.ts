import { log } from "../cli/log.ts";

/**
 * Translate an MCP-spec tool inputSchema into the narrower shape every
 * major LLM provider's tool-validator accepts.
 *
 * ## The constraint
 *
 * Verified against OpenAI (Chat Completions + Responses) and Anthropic
 * Messages as of 2026-05-12 — both reject identical shapes with identical
 * messages:
 *
 *   1. Root must be `type: "object"` with an explicit `properties` field.
 *   2. Root must NOT contain `oneOf` / `anyOf` / `allOf` / `enum` / `not`.
 *
 * Anywhere deeper than the root, every JSON Schema keyword is allowed —
 * the providers only enforce the constraint at the top level, so this
 * transform never walks into properties. Revisit if a provider API
 * version bump tightens the rules.
 *
 * ## Strategy
 *
 * Single transform at the one boundary every tool crosses (engine.ts →
 * LanguageModelV3FunctionTool). The MCP source layer remains a faithful
 * pass-through of the vendor-emitted schema; downstream consumers
 * (validation, audit, debugging) see the original.
 *
 *   - `oneOf` / `anyOf` at root → **union-merge** branch properties;
 *     intersect required arrays. The LLM sees every reachable field
 *     across all branches but is told to require only what every branch
 *     requires (i.e., nothing branch-specific).
 *
 *     This is safe because the engine validates the LLM's emitted args
 *     against the *original* schema (see `engine.ts` call to
 *     `validateToolInput` — the schema map holds pre-transform Tools).
 *     Ajv compiles `oneOf` correctly: a payload matching 0 or >1 branches
 *     is rejected before the tool runs, the error is fed back, and the
 *     model self-corrects on the next iteration. So an invalid
 *     mix-and-match costs at most one wasted LLM turn — strictly better
 *     than picking a single branch and rendering the others unreachable
 *     (e.g. Dropbox `list_folder`'s `shared_link` branch).
 *
 *   - `allOf` at root → union-merge branch properties; **union** required
 *     arrays. `allOf` means all branches hold simultaneously, so anything
 *     required in any branch is universally required.
 *
 *   - On property-key collision across branches: **last branch wins**.
 *     A vendor that reuses the same property name with different shapes
 *     across branches is already malformed; predictable spread-style
 *     last-wins beats inventing a property-level oneOf. The MCP server's
 *     own validation still gates the actual call.
 *
 *   - `enum` / `not` at root → stripped. Neither has a flat-object
 *     representation and the MCP spec doesn't anticipate them as root
 *     schemas for tool inputs.
 *
 *   - After all rewrites, `type: "object"` and a plain-object
 *     `properties` are guaranteed to exist.
 *
 * ## Input contract
 *
 * `raw: unknown` — defensive by design. `null`/`undefined` is treated as
 * "tool declares no input" (legitimate); any other non-object is treated
 * as an upstream bug and logged via `log.warn` with the tool name so the
 * source can be fixed. Both cases coerce to an empty object schema so
 * the agent loop keeps running.
 */
export function toolSchemaForLlm(raw: unknown, toolName?: string): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    return emptyObjectSchema();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    const actual = Array.isArray(raw) ? "array" : typeof raw;
    log.warn(
      `[engine] toolSchemaForLlm: non-object inputSchema for tool ${
        toolName ? `"${toolName}"` : "<unknown>"
      } (got ${actual}); coercing to empty object schema. ` +
        "This indicates an upstream bug in the tool source.",
    );
    return emptyObjectSchema();
  }

  let schema: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    schema = mergeRootComposition(schema, "oneOf");
  } else if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    schema = mergeRootComposition(schema, "anyOf");
  } else if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    schema = mergeRootComposition(schema, "allOf");
  }

  if ("enum" in schema) delete schema.enum;
  if ("not" in schema) delete schema.not;

  if (schema.type !== "object") schema.type = "object";
  if (!isPlainObject(schema.properties)) schema.properties = {};

  return schema;
}

function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge a root-level `oneOf` / `anyOf` / `allOf` into a single object
 * schema. Properties union across branches (last-wins on collision);
 * `required` semantics differ per keyword (see top-level docstring).
 *
 * Branches that aren't plain objects are skipped — JSON Schema permits
 * boolean schemas (`true`/`false`) as branches, but for tool input use
 * cases they carry no merge information.
 */
function mergeRootComposition(
  schema: Record<string, unknown>,
  key: "oneOf" | "anyOf" | "allOf",
): Record<string, unknown> {
  const branches = (schema[key] as unknown[]).filter(isPlainObject);

  const mergedProperties: Record<string, unknown> = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  for (const branch of branches) {
    if (isPlainObject(branch.properties)) {
      Object.assign(mergedProperties, branch.properties);
    }
  }

  const required = mergeRequired(schema, branches, key);

  const out = { ...schema };
  delete out[key];
  out.properties = mergedProperties;
  if (required.length > 0) {
    out.required = required;
  } else {
    delete out.required;
  }
  return out;
}

/**
 * `allOf`: every branch holds → required = root ∪ (∪ branch.required).
 * `oneOf` / `anyOf`: exactly one branch holds → a field is universally
 * required only if every branch requires it → root ∪ (∩ branch.required).
 */
function mergeRequired(
  schema: Record<string, unknown>,
  branches: Array<Record<string, unknown>>,
  key: "oneOf" | "anyOf" | "allOf",
): string[] {
  const rootRequired = readStringArray(schema.required);
  const branchRequireds = branches.map((b) => readStringArray(b.required));

  if (key === "allOf") {
    const merged = new Set(rootRequired);
    for (const r of branchRequireds) for (const f of r) merged.add(f);
    return [...merged];
  }

  if (branchRequireds.length === 0) return rootRequired;
  const intersected = branchRequireds.reduce<string[]>(
    (acc, cur) => acc.filter((f) => cur.includes(f)),
    branchRequireds[0] ?? [],
  );
  return [...new Set([...rootRequired, ...intersected])];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
