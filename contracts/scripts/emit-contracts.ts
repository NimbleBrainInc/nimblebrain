#!/usr/bin/env bun
/**
 * Emit every contract document from its authoring source.
 *
 *   bun --no-env-file contracts/scripts/emit-contracts.ts           # write
 *   bun --no-env-file contracts/scripts/emit-contracts.ts --check   # verify
 *
 * Each document is a published contract and is committed under the repo's
 * `schemas/` tree, at the path its `$id` names on `schemas.nimblebrain.ai`
 * (`schemas/contracts/<short-name>/v<major>/contract.json`). Each is authored in
 * `contracts/<short-name>/source/`, whose `index.ts` exports a `ContractSource`:
 * the identity, version, cardinality, each tool's visibility, unattended
 * marking and grant, the errors, the tools' TypeBox schemas by visibility, and
 * the named schemas tools share.
 *
 * Each tool's input and output schema sits in `$defs` under `<tool>_input` and
 * `<tool>_output` (a JSON round trip, which drops TypeBox's symbol-keyed
 * metadata), and the tool's entry points at it with a `$ref`. A schema several
 * tools share sits in `$defs` under its own name, and a tool's schema refers to
 * it as `#/$defs/<name>`: the same pointer resolves in the document and in a
 * tool schema listed with those `$defs` bundled beside it. A shared schema
 * refers to nothing.
 *
 * The emitter refuses a source whose schemas and declared tools disagree, a
 * private tool that is not `unattended: "refused"`, a `grant` on a private
 * tool or on one an unattended run may call, a `$ref` in a public tool's
 * schema (public schemas are whole, for every MCP client), a `$ref` that names
 * no shared schema, and a nested `$defs` in any tool's schema.
 *
 * `--check` writes nothing. It exits 1 when a committed document is missing or
 * differs from what would be emitted, and prints the first differing line.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SOURCE as CONVERSATIONS } from "../conversations/source/index.ts";
import { SOURCE as FILES } from "../files/source/index.ts";
import { SOURCE as TASKS } from "../tasks/source/index.ts";
import type { ContractSource, ContractToolEntry, Visibility } from "./contract-source.ts";

/** Every contract this repository publishes. */
export const SOURCES: readonly ContractSource[] = [CONVERSATIONS, TASKS, FILES];

const REPO = resolve(import.meta.dir, "../..");
const PUBLISHED_ORIGIN = "https://schemas.nimblebrain.ai/";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** The `$defs` key of a tool's input or output schema. */
export const defKey = (tool: string, kind: "input" | "output") => `${tool}_${kind}`;

/** The repo path of a document: `schemas/` mirrors what the published origin serves. */
export function pathOf($id: string): string {
  if (!$id.startsWith(PUBLISHED_ORIGIN)) {
    throw new Error(`$id ${$id} is not under ${PUBLISHED_ORIGIN}`);
  }
  return join(REPO, "schemas", $id.slice(PUBLISHED_ORIGIN.length));
}

/** Every `$ref` value in a JSON value, in document order. */
export function refsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) =>
    k === "$ref" && typeof v === "string" ? [v] : refsOf(v),
  );
}

/** Whether a JSON value holds `key` as an object key at any depth. */
export function holdsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => holdsKey(v, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([k, v]) => k === key || holdsKey(v, key));
}

/** The shared schema a `$ref` names, or undefined when it names none. */
function sharedName(ref: string, shared: Record<string, unknown>): string | undefined {
  const name = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
  return name !== undefined && Object.hasOwn(shared, name) ? name : undefined;
}

/** Throw when one tool's entry breaks a rule of the document. */
function checkTool(source: ContractSource, tool: string, entry: ContractToolEntry): void {
  const { meta, schemas } = source;
  const { visibility, unattended, grant } = entry;
  const pair = schemas[visibility][tool];
  if (!pair) {
    throw new Error(
      `${meta.contract}: the contract names ${visibility} tool "${tool}", which has no ${visibility} source`,
    );
  }
  if (visibility === "private" && unattended !== "refused") {
    throw new Error(`${meta.contract}: private tool "${tool}" must be unattended "refused"`);
  }
  if (grant && (visibility !== "public" || unattended !== "refused")) {
    throw new Error(
      `${meta.contract}: "${tool}" carries a grant, which only a public tool refused to unattended runs may`,
    );
  }
  for (const kind of ["input", "output"] as const) {
    checkToolSchema(source, `${tool}'s ${kind}`, visibility, pair[kind]);
  }
}

/** Throw when a tool's schema nests `$defs`, or holds a `$ref` it may not. */
function checkToolSchema(
  { meta, shared = {} }: ContractSource,
  what: string,
  visibility: Visibility,
  schema: unknown,
): void {
  const json: unknown = JSON.parse(JSON.stringify(schema));
  if (holdsKey(json, "$defs")) {
    throw new Error(`${meta.contract}: ${what} nests $defs; share a schema instead`);
  }
  const refs = refsOf(json);
  if (visibility === "public" && refs.length > 0) {
    throw new Error(`${meta.contract}: public ${what} holds a $ref`);
  }
  for (const ref of refs) {
    if (!sharedName(ref, shared)) {
      throw new Error(`${meta.contract}: ${what} refers to ${ref}, no shared schema`);
    }
  }
}

/** Throw when a source's schemas and its declared tools disagree. */
function checkSource(source: ContractSource): void {
  const { meta, schemas, shared = {} } = source;
  for (const [tool, entry] of Object.entries(meta.tools)) checkTool(source, tool, entry);
  for (const [visibility, tools] of Object.entries(schemas) as [Visibility, object][]) {
    for (const tool of Object.keys(tools)) {
      if (meta.tools[tool]?.visibility !== visibility) {
        throw new Error(
          `${meta.contract}: the ${visibility} source has "${tool}", which the contract does not mark ${visibility}`,
        );
      }
    }
  }
  for (const [name, schema] of Object.entries(shared)) {
    if (refsOf(JSON.parse(JSON.stringify(schema))).length > 0) {
      throw new Error(`${meta.contract}: shared schema "${name}" refers to another schema`);
    }
  }
}

/** One contract document, as committed text. */
export function emit(source: ContractSource): string {
  checkSource(source);
  const { meta, schemas, shared = {} } = source;
  const tools: Record<string, unknown> = {};
  const defs: Record<string, unknown> = {};
  for (const [tool, { visibility, unattended, grant }] of Object.entries(meta.tools)) {
    const pair = schemas[visibility][tool];
    if (!pair) throw new Error(`${meta.contract}: no schemas for "${tool}"`);
    const entry: Record<string, unknown> = { visibility, unattended };
    if (grant) entry.grant = true;
    for (const kind of ["input", "output"] as const) {
      const key = defKey(tool, kind);
      entry[kind] = { $ref: `#/$defs/${key}` };
      defs[key] = JSON.parse(JSON.stringify(pair[kind]));
    }
    tools[tool] = entry;
  }
  for (const [name, schema] of Object.entries(shared)) {
    if (Object.hasOwn(defs, name)) {
      throw new Error(`${meta.contract}: shared schema "${name}" collides with a tool's $defs key`);
    }
    defs[name] = JSON.parse(JSON.stringify(schema));
  }
  const doc = {
    $schema: DRAFT,
    $id: meta.$id,
    title: meta.title,
    description: meta.description,
    contract: meta.contract,
    version: meta.version,
    cardinality: meta.cardinality,
    tools,
    errors: meta.errors,
    $defs: defs,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The first line where two texts differ, for a one-line drift summary. */
function firstDifference(committed: string, emitted: string): string {
  const a = committed.split("\n");
  const b = emitted.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}: committed ${JSON.stringify(a[i] ?? "<eof>")}, emitted ${JSON.stringify(b[i] ?? "<eof>")}`;
    }
  }
  return "differs";
}

function main(): void {
  const check = process.argv.includes("--check");
  const problems: string[] = [];
  for (const source of SOURCES) {
    const path = pathOf(source.meta.$id);
    const shown = relative(process.cwd(), path);
    const text = emit(source);
    const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (current === text) {
      process.stdout.write(`contract document up to date (${shown})\n`);
      continue;
    }
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      process.stdout.write(`wrote ${shown}\n`);
      continue;
    }
    problems.push(
      current === null
        ? `missing  ${shown}`
        : `stale    ${shown} (${firstDifference(current, text)})`,
    );
  }
  if (problems.length > 0) {
    process.stderr.write(
      `${problems.join("\n")}\n\nA contract document is out of date with its source. Run: bun run emit:contracts\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
