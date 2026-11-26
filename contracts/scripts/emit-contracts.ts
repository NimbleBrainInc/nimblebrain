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
 * the identity, version, cardinality, grants, each tool's visibility and
 * unattended marking, the errors, and the tools' TypeBox schemas by visibility.
 *
 * Each tool's input and output schema sits in `$defs` under `<tool>_input` and
 * `<tool>_output`, exactly as it travels in `tools/list` (a JSON round trip,
 * which drops TypeBox's symbol-keyed metadata), and the tool's entry points at
 * it with a `$ref`. Each tool's schema source must match its visibility, and a
 * private tool is always `unattended: "refused"`.
 *
 * `--check` writes nothing. It exits 1 when a committed document is missing or
 * differs from what would be emitted, and prints the first differing line.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SOURCE as CONVERSATIONS } from "../conversations/source/index.ts";
import { SOURCE as TASKS } from "../tasks/source/index.ts";
import type { ContractSource, Visibility } from "./contract-source.ts";

/** Every contract this repository publishes. */
export const SOURCES: readonly ContractSource[] = [CONVERSATIONS, TASKS];

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

/** Throw when a source's schemas and its declared tools disagree. */
function checkSource({ meta, schemas }: ContractSource): void {
  for (const [tool, { visibility, unattended }] of Object.entries(meta.tools)) {
    if (!schemas[visibility][tool]) {
      throw new Error(
        `${meta.contract}: the contract names ${visibility} tool "${tool}", which has no ${visibility} source`,
      );
    }
    if (visibility === "private" && unattended !== "refused") {
      throw new Error(`${meta.contract}: private tool "${tool}" must be unattended "refused"`);
    }
  }
  for (const [visibility, source] of Object.entries(schemas) as [Visibility, object][]) {
    for (const tool of Object.keys(source)) {
      if (meta.tools[tool]?.visibility !== visibility) {
        throw new Error(
          `${meta.contract}: the ${visibility} source has "${tool}", which the contract does not mark ${visibility}`,
        );
      }
    }
  }
}

/** One contract document, as committed text. */
export function emit(source: ContractSource): string {
  checkSource(source);
  const { meta, schemas } = source;
  const tools: Record<string, unknown> = {};
  const defs: Record<string, unknown> = {};
  for (const [tool, { visibility, unattended }] of Object.entries(meta.tools)) {
    const pair = schemas[visibility][tool];
    if (!pair) throw new Error(`${meta.contract}: no schemas for "${tool}"`);
    const entry: Record<string, unknown> = { visibility, unattended };
    for (const kind of ["input", "output"] as const) {
      const key = defKey(tool, kind);
      entry[kind] = { $ref: `#/$defs/${key}` };
      defs[key] = JSON.parse(JSON.stringify(pair[kind]));
    }
    tools[tool] = entry;
  }
  const doc = {
    $schema: DRAFT,
    $id: meta.$id,
    title: meta.title,
    description: meta.description,
    contract: meta.contract,
    version: meta.version,
    cardinality: meta.cardinality,
    grants: meta.grants,
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
