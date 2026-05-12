/**
 * The single transform that maps an MCP-spec tool inputSchema into the
 * narrower shape every major LLM provider's tool-schema validator accepts.
 *
 * The constraint set, derived from the OpenAI Chat Completions / Responses
 * and Anthropic Messages APIs (both reject identical shapes with identical
 * messages):
 *
 *   1. Root must be `type: "object"` with an explicit `properties` field.
 *   2. Root must NOT contain `oneOf` / `anyOf` / `allOf` / `enum` / `not`.
 *
 * Anywhere deeper than the root, every keyword is allowed — the providers
 * only enforce the constraint at the top level. We mirror that scope: this
 * function rewrites root keywords only and never walks into properties,
 * preserving every bit of vendor information that wasn't blocking the call.
 *
 * Transformation rules:
 *
 *   - `oneOf` / `anyOf` at root → take the FIRST branch. A oneOf says
 *     "exactly one of these shapes"; any valid call already satisfies
 *     exactly one. Picking branch[0] yields a schema that, when satisfied,
 *     IS a valid tool input. Synthesizing a union (merging all branches)
 *     would invite mix-and-match payloads that match no real branch — a
 *     strictly worse failure mode than losing access to alternative branches.
 *     Vendors typically order branches by canonical use.
 *
 *   - `allOf` at root → merge every branch. `allOf` means "all must hold
 *     simultaneously", so combining their properties and unioning required
 *     is semantically faithful, not lossy.
 *
 *   - `enum` / `not` at root → drop. Neither has a meaningful flat-object
 *     representation, and the MCP spec doesn't suggest vendors should
 *     declare entire tool inputs as enums.
 *
 *   - After transformation, `type: "object"` and `properties: {}` are
 *     guaranteed to exist.
 *
 * The MCP server itself still enforces strict semantics on the actual call,
 * so any invalid combo the LLM emits surfaces as a tool error and the
 * agent self-corrects.
 */
export function toolSchemaForLlm(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") {
    return { type: "object", properties: {} };
  }
  let schema: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    schema = collapseToFirstBranch(schema, "oneOf");
  } else if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    schema = collapseToFirstBranch(schema, "anyOf");
  } else if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    schema = mergeAllOf(schema);
  }

  if ("enum" in schema) delete schema.enum;
  if ("not" in schema) delete schema.not;

  if (schema.type !== "object") schema.type = "object";
  if (schema.properties === undefined) schema.properties = {};

  return schema;
}

/**
 * Replace the schema with branches[0], preserving any root-level keys
 * that the branch doesn't define (description, title, $defs, etc.).
 * Branch values win on conflict — the branch is the source of truth
 * for shape, the root for documentation.
 */
function collapseToFirstBranch(
  schema: Record<string, unknown>,
  key: "oneOf" | "anyOf",
): Record<string, unknown> {
  const branches = schema[key] as unknown[];
  const first = branches[0];
  if (first === null || typeof first !== "object") {
    const copy = { ...schema };
    delete copy[key];
    return copy;
  }
  const branch = first as Record<string, unknown>;
  const rootRest = { ...schema };
  delete rootRest[key];
  return { ...rootRest, ...branch };
}

/**
 * Merge every allOf branch into a single object schema. Properties union;
 * required unions (deduped); branch values win over root on conflict.
 */
function mergeAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = (schema.allOf as unknown[]).filter(
    (b): b is Record<string, unknown> => b !== null && typeof b === "object",
  );
  const mergedProperties: Record<string, unknown> = {
    ...((schema.properties as Record<string, unknown>) ?? {}),
  };
  const mergedRequired = new Set<string>(
    Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter((r): r is string => typeof r === "string")
      : [],
  );
  for (const branch of branches) {
    const branchProps = branch.properties;
    if (branchProps !== null && typeof branchProps === "object") {
      Object.assign(mergedProperties, branchProps as Record<string, unknown>);
    }
    if (Array.isArray(branch.required)) {
      for (const r of branch.required) {
        if (typeof r === "string") mergedRequired.add(r);
      }
    }
  }
  const out = { ...schema };
  delete out.allOf;
  out.properties = mergedProperties;
  if (mergedRequired.size > 0) out.required = Array.from(mergedRequired);
  return out;
}
