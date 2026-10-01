/**
 * Unknown-argument check for model tool calls.
 *
 * JSON Schema leaves an object open unless it says `additionalProperties:
 * false`, and most generated tool schemas (FastMCP's among them) never say it.
 * So a schema-valid call can still carry an argument name the tool does not
 * declare: the server either rejects it with an error that names only the bad
 * key, or drops it silently. Either way the model learns nothing about the
 * names it should have used.
 *
 * The engine treats a schema that declares `properties` and nothing that
 * opens it (`additionalProperties` true or a schema, `patternProperties`,
 * `unevaluatedProperties`, an unresolved `$ref`) as the complete list of
 * argument names. A call naming anything else is rejected before dispatch,
 * with the declared arguments listed so the model can correct in one step.
 *
 * This applies to model calls only. `validateToolInput` keeps plain JSON
 * Schema semantics for the other callers of a tool (the UI and `/mcp`).
 */

type Schema = Record<string, unknown>;

const COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

/** Longest description carried into the argument list, so one verbose tool cannot flood the result. */
const MAX_DESCRIPTION_CHARS = 200;
/** Most enum values listed for one argument. */
const MAX_ENUM_VALUES = 10;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function branchesOf(node: Schema, keywords: readonly string[] = COMPOSITION_KEYWORDS): Schema[] {
  return keywords.flatMap((keyword) => {
    const list = node[keyword];
    return Array.isArray(list) ? list.filter(isSchema) : [];
  });
}

/** True when the node itself admits keys beyond its `properties`. */
function opensKeySet(node: Schema): boolean {
  if (typeof node.$ref === "string") return true;
  for (const keyword of ["additionalProperties", "unevaluatedProperties"] as const) {
    const value = node[keyword];
    if (value !== undefined && value !== false) return true;
  }
  const pattern = node.patternProperties;
  return isSchema(pattern) && Object.keys(pattern).length > 0;
}

/**
 * Every argument name the schema declares, from the root `properties` and
 * from `allOf` / `anyOf` / `oneOf` branches (recursively). Null when the key
 * set is open or the schema declares no `properties` anywhere: then there is
 * no closed list to check against.
 */
function declaredArgumentNames(schema: Schema): Set<string> | null {
  const names = new Set<string>();
  let declaresProperties = false;
  const visit = (node: Schema): boolean => {
    if (opensKeySet(node)) return false;
    if (isSchema(node.properties)) {
      declaresProperties = true;
      for (const key of Object.keys(node.properties)) names.add(key);
    }
    return branchesOf(node).every(visit);
  };
  if (!visit(schema) || !declaresProperties) return null;
  return names;
}

/** Keys in `input` the schema does not declare; empty when the key set is open. */
export function unknownArgumentNames(input: Record<string, unknown>, schema: Schema): string[] {
  const declared = declaredArgumentNames(schema);
  if (!declared) return [];
  return Object.keys(input).filter((key) => !declared.has(key));
}

function typeLabel(prop: Schema): string {
  const type = prop.type;
  if (typeof type === "string") {
    if (type === "array" && isSchema(prop.items) && typeof prop.items.type === "string") {
      return `array of ${prop.items.type}`;
    }
    return type;
  }
  if (Array.isArray(type)) return type.join(" | ");
  const branches = [
    ...(Array.isArray(prop.anyOf) ? prop.anyOf : []),
    ...(Array.isArray(prop.oneOf) ? prop.oneOf : []),
  ]
    .filter(isSchema)
    .map(typeLabel)
    .filter((label) => label !== "any");
  if (branches.length > 0) return [...new Set(branches)].join(" | ");
  return "any";
}

function enumLabel(prop: Schema): string | null {
  if (!Array.isArray(prop.enum) || prop.enum.length === 0) return null;
  const shown = prop.enum.slice(0, MAX_ENUM_VALUES).map((v) => JSON.stringify(v));
  const more = prop.enum.length > MAX_ENUM_VALUES ? ", ..." : "";
  return `one of ${shown.join(", ")}${more}`;
}

function shortDescription(prop: Schema): string | null {
  if (typeof prop.description !== "string") return null;
  const text = prop.description.trim().replace(/\s+/g, " ");
  if (text.length === 0) return null;
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}...` : text;
}

/**
 * Declared arguments in schema order, first declaration winning. Required
 * means required in every valid input: the root `required` and each `allOf`
 * branch's, not an `anyOf` / `oneOf` alternative's.
 */
function collectArguments(schema: Schema): { props: Map<string, Schema>; required: Set<string> } {
  const args = { props: new Map<string, Schema>(), required: new Set<string>() };
  collectInto(schema, true, args);
  return args;
}

function collectInto(
  node: Schema,
  mandatory: boolean,
  args: { props: Map<string, Schema>; required: Set<string> },
): void {
  const declared = isSchema(node.properties) ? Object.entries(node.properties) : [];
  for (const [key, value] of declared) {
    if (!args.props.has(key)) args.props.set(key, isSchema(value) ? value : {});
  }
  const required = mandatory && Array.isArray(node.required) ? node.required : [];
  for (const key of required) if (typeof key === "string") args.required.add(key);
  for (const branch of branchesOf(node, ["allOf"])) collectInto(branch, mandatory, args);
  for (const branch of branchesOf(node, ["anyOf", "oneOf"])) collectInto(branch, false, args);
}

/** The isError text for a call carrying undeclared arguments: the bad names first, then every valid one. */
export function formatUnknownArgumentsError(
  toolName: string,
  unknown: string[],
  schema: Schema,
): string {
  const named = unknown.map((key) => `"${key}"`).join(", ");
  const head = `Invalid tool input: ${toolName} has no argument${unknown.length === 1 ? "" : "s"} named ${named}.`;
  const { props, required } = collectArguments(schema);
  if (props.size === 0) return `${head} This tool takes no arguments.`;
  const lines = [...props].map(([key, prop]) => {
    const traits = [typeLabel(prop)];
    if (required.has(key)) traits.push("required");
    const choices = enumLabel(prop);
    if (choices) traits.push(choices);
    const description = shortDescription(prop);
    return `- ${key} (${traits.join(", ")})${description ? `: ${description}` : ""}`;
  });
  return `${head} Valid arguments:\n${lines.join("\n")}`;
}
