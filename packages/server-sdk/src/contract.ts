/**
 * A contract document as published (`schemas/contracts/<name>/v<major>/contract.json`), and
 * the facts a server takes from it rather than restating: each tool's visibility and its
 * input and output schemas. Which tools are private is the contract's decision, so a
 * server asks the document, never a list of its own.
 */

import { type CallContext, isHost } from "./context.ts";
import { type ToolErrorResult, toolError } from "./errors.ts";

export type Visibility = "public" | "private";

/** One tool's entry in a contract document. */
export interface ContractTool {
  visibility: Visibility;
  /** Whether a call made inside an unattended run may reach the tool. */
  unattended?: "allowed" | "refused";
  /** Whether the host stamps a run grant on a person's call to the tool. */
  grant?: true;
  input: { $ref: string };
  output: { $ref: string };
}

/** The parts of a contract document a server reads. */
export interface ContractDocument {
  $id: string;
  contract: string;
  version: string;
  tools: Record<string, ContractTool>;
  errors: {
    public: Array<{ code: string; prefix: string }>;
    private: Array<{ code: string }>;
  };
  $defs: Record<string, Record<string, unknown>>;
}

/** The tool's visibility, or undefined when the contract has no such tool. */
export function toolVisibility(doc: ContractDocument, tool: string): Visibility | undefined {
  return Object.hasOwn(doc.tools, tool) ? doc.tools[tool]?.visibility : undefined;
}

/** The contract's tools of one visibility, in document order. */
export function toolsOf(doc: ContractDocument, visibility: Visibility): string[] {
  return Object.entries(doc.tools)
    .filter(([, t]) => t.visibility === visibility)
    .map(([name]) => name);
}

const DEFS_PREFIX = "#/$defs/";

/** The `$defs` keys a schema refers to as `#/$defs/<name>`, in document order. */
function sharedRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) sharedRefs(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith(DEFS_PREFIX)) {
        into.add(v.slice(DEFS_PREFIX.length));
      } else {
        sharedRefs(v, into);
      }
    }
  }
  return into;
}

/**
 * A tool's input or output schema, as a server lists it as the tool's `inputSchema` or
 * `outputSchema`: the `$defs` entry its `$ref` names. When that entry refers to schemas the
 * document shares (`#/$defs/<name>`), they are bundled beside it under the same keys, so the
 * same pointers resolve in the listed schema. The answer is a copy: changing it changes
 * nothing in the document.
 */
export function contractSchema(
  doc: ContractDocument,
  tool: string,
  kind: "input" | "output",
): Record<string, unknown> {
  const ref = doc.tools[tool]?.[kind].$ref;
  const key = ref?.startsWith(DEFS_PREFIX) ? ref.slice(DEFS_PREFIX.length) : undefined;
  const schema = key ? doc.$defs[key] : undefined;
  if (!schema) throw new Error(`${doc.contract}: no ${kind} schema for tool "${tool}"`);
  const names = sharedRefs(schema);
  if (names.size === 0) return structuredClone(schema);
  const defs: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    const shared = doc.$defs[name];
    if (!shared)
      throw new Error(`${doc.contract}: ${tool}'s ${kind} refers to missing $defs/${name}`);
    defs[name] = shared;
  }
  return structuredClone({ ...schema, $defs: defs });
}

/** The prefix a public error's text begins with, from the document's `errors.public`. */
export function publicErrorPrefix(doc: ContractDocument, code: string): string {
  const entry = doc.errors.public.find((e) => e.code === code);
  if (!entry) throw new Error(`${doc.contract}: no public error "${code}"`);
  return entry.prefix;
}

/**
 * The principal rule, checked first on every call: a private tool called by anyone but the
 * host fails `forbidden`, before its input or scope is looked at, so the answer reveals
 * nothing about either. Returns the refusal, or null when the call may proceed.
 */
export function refuseUnlessAllowed(
  doc: ContractDocument,
  tool: string,
  ctx: CallContext,
): ToolErrorResult | null {
  if (toolVisibility(doc, tool) !== "private" || isHost(ctx)) return null;
  return toolError("forbidden", `"${tool}" is a private tool: only the host may call it`);
}
