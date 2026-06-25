import { log } from "../observability/log.ts";

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
 * ### `oneOf` / `anyOf` at root → **first branch wins** (lossy, but only
 * representable choice).
 *
 * An earlier iteration tried union-merge ("show the LLM every reachable
 * field; let Ajv-over-original reject invalid combos") on the theory that
 * post-hoc validation would let the model self-correct. Empirically that
 * fails — observed with Dropbox `list_folder` (which uses oneOf to model
 * `path` vs `cursor` continuation): the model emits both fields together,
 * Ajv rejects with `must NOT have additional properties; must match
 * exactly one schema in oneOf`, and that error message gives the model
 * no signal about *which* field to drop or *which* branch was nearest.
 * The model loops with cosmetic variations until it hits the iteration
 * cap.
 *
 * The lesson: post-hoc validation only constitutes a recovery loop when
 * its error messages are recoverable. JSON Schema `oneOf` errors are not.
 *
 * First-branch is the closest representable approximation we can hand
 * the LLM: a schema it can satisfy on the first call. Alternative
 * branches become unreachable; that loss is real but bounded (vendors
 * order branches by canonical use — `path` is the 99% case for Dropbox).
 * Operators are warned via `log.warn` so the loss is visible. The
 * permanent fix lives upstream — vendor MCP servers should flatten
 * top-level composition, since no LLM provider supports it.
 *
 * ### `allOf` at root → union-merge (semantically faithful).
 *
 * `allOf` means every branch holds simultaneously, so merging properties
 * across branches and unioning required arrays is the truthful
 * representation. No information is lost; the LLM sees the full schema.
 *
 * ### `enum` / `not` at root → stripped.
 *
 * Neither has a flat-object representation and the MCP spec doesn't
 * anticipate them as root schemas for tool inputs.
 *
 * After all rewrites, `type: "object"` and a plain-object `properties`
 * are guaranteed to exist.
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
    schema = collapseToFirstBranch(schema, "oneOf", toolName);
  } else if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    schema = collapseToFirstBranch(schema, "anyOf", toolName);
  } else if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    schema = mergeAllOf(schema);
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
 * Replace the schema with branches[0]. Root-level keys that the branch
 * doesn't define (description, title, $defs, etc.) are preserved; branch
 * values win on conflict (branch is the source of truth for shape, root
 * for documentation).
 *
 * Surfaces the loss to operators when branches beyond the first carry
 * properties the LLM will never see — that's the architectural cost of
 * first-branch and they should be able to spot it in logs.
 */
function collapseToFirstBranch(
  schema: Record<string, unknown>,
  key: "oneOf" | "anyOf",
  toolName?: string,
): Record<string, unknown> {
  const branches = (schema[key] as unknown[]).filter(isPlainObject);
  if (branches.length === 0) {
    const copy = { ...schema };
    delete copy[key];
    return copy;
  }

  if (branches.length > 1) {
    warnDroppedBranches(branches, key, toolName);
  }

  const rootRest = { ...schema };
  delete rootRest[key];
  return { ...rootRest, ...branches[0] };
}

/**
 * Emit one log line per tool listing properties that exist in dropped
 * branches but not in the kept one — those are the fields no LLM call
 * via this tool can ever set. If the dropped branches add no novel
 * properties (e.g. they only re-shape kept ones with different types),
 * the warning still fires but with an empty list, because the kept
 * branch's shape still misrepresents the alternatives semantically.
 */
function warnDroppedBranches(
  branches: Array<Record<string, unknown>>,
  key: "oneOf" | "anyOf",
  toolName?: string,
): void {
  const keptProps = isPlainObject(branches[0]?.properties)
    ? new Set(Object.keys(branches[0].properties as Record<string, unknown>))
    : new Set<string>();
  const lostProps = new Set<string>();
  for (let i = 1; i < branches.length; i++) {
    const b = branches[i];
    if (b && isPlainObject(b.properties)) {
      for (const p of Object.keys(b.properties)) {
        if (!keptProps.has(p)) lostProps.add(p);
      }
    }
  }
  const lostList =
    lostProps.size > 0 ? [...lostProps].join(", ") : "(none — branches reshape kept properties)";
  log.warn(
    `[engine] toolSchemaForLlm: tool ${toolName ? `"${toolName}"` : "<unknown>"} ` +
      `has a top-level ${key} with ${branches.length} branches; LLM providers don't ` +
      `support top-level composition, so only the first branch is exposed. ` +
      `Properties unreachable in dropped branches: ${lostList}. ` +
      "The permanent fix is for the MCP source to flatten its tool schema.",
  );
}

/**
 * Merge every `allOf` branch into a single object schema. Properties union
 * (last-wins on collision); required is the union of root + every
 * branch's required. Semantically faithful — `allOf` means every branch
 * must hold simultaneously, so anything required anywhere is universally
 * required.
 *
 * Branches that aren't plain objects are skipped — JSON Schema permits
 * boolean schemas (`true`/`false`) as branches but they carry no
 * mergeable shape information for tool inputs.
 */
function mergeAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = (schema.allOf as unknown[]).filter(isPlainObject);

  const mergedProperties: Record<string, unknown> = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  for (const branch of branches) {
    if (isPlainObject(branch.properties)) {
      Object.assign(mergedProperties, branch.properties);
    }
  }

  const rootRequired = readStringArray(schema.required);
  const required = new Set(rootRequired);
  for (const branch of branches) {
    for (const r of readStringArray(branch.required)) required.add(r);
  }

  const out = { ...schema };
  delete out.allOf;
  out.properties = mergedProperties;
  if (required.size > 0) {
    out.required = [...required];
  } else {
    delete out.required;
  }
  return out;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
