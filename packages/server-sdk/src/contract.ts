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

/**
 * A tool's input or output schema: the `$defs` entry its `$ref` names, which is the schema
 * a server lists as the tool's `inputSchema` or `outputSchema`.
 */
export function contractSchema(
  doc: ContractDocument,
  tool: string,
  kind: "input" | "output",
): Record<string, unknown> {
  const ref = doc.tools[tool]?.[kind].$ref;
  const prefix = "#/$defs/";
  const key = ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
  const schema = key ? doc.$defs[key] : undefined;
  if (!schema) throw new Error(`${doc.contract}: no ${kind} schema for tool "${tool}"`);
  return schema;
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
