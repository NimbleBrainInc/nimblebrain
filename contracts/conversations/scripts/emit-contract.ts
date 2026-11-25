#!/usr/bin/env bun
/**
 * Emit the conversations contract as one JSON document from its authoring
 * sources.
 *
 *   bun --no-env-file contracts/conversations/scripts/emit-contract.ts           # write
 *   bun --no-env-file contracts/conversations/scripts/emit-contract.ts --check   # verify
 *
 * The document is the published contract and is committed under the repo's
 * `schemas/` tree, at the path its `$id` names on `schemas.nimblebrain.ai`
 * (`schemas/contracts/conversations/v1/contract.json`). It is authored in three
 * places: `../source/contract.ts` (identity, version, cardinality, tool
 * visibility, errors), `../source/private.ts` (the private tools' schemas), and
 * `src/platform/schemas/conversations.ts` (the public tools' schemas, which are
 * today's conversations tools). This script is build tooling; it is the one
 * place in `contracts/` that reads an authoring source under `src/`.
 *
 * Each tool's input and output schema sits in `$defs` under `<tool>_input` and
 * `<tool>_output`, exactly as it travels in `tools/list` (a JSON round trip,
 * which drops TypeBox's symbol-keyed metadata), and the tool's entry points at
 * it with a `$ref`. Each tool's schema source must match its visibility.
 *
 * `--check` writes nothing. It exits 1 when the committed document is missing
 * or differs from what would be emitted, and prints the first differing line.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import * as App from "../../../src/platform/schemas/conversations.ts";
import { CONTRACT, type Visibility } from "../source/contract.ts";
import { PRIVATE_SCHEMAS } from "../source/private.ts";

const REPO = resolve(import.meta.dir, "../../..");
const PUBLISHED_ORIGIN = "https://schemas.nimblebrain.ai/";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

type ToolSchemas = Record<string, { input: TSchema; output: TSchema }>;

const PUBLIC_SCHEMAS: ToolSchemas = {
  list: { input: App.ConversationsListInput, output: App.ConversationsListOutput },
  get: { input: App.ConversationsGetInput, output: App.ConversationsGetOutput },
  search: { input: App.ConversationsSearchInput, output: App.ConversationsSearchOutput },
  update: { input: App.ConversationsUpdateInput, output: App.ConversationsUpdateOutput },
  stats: { input: App.ConversationsStatsInput, output: App.ConversationsStatsOutput },
  export: { input: App.ConversationsExportInput, output: App.ConversationsExportOutput },
};

const SOURCES: Record<Visibility, ToolSchemas> = {
  public: PUBLIC_SCHEMAS,
  private: PRIVATE_SCHEMAS,
};

/** The `$defs` key of a tool's input or output schema. */
export const defKey = (tool: string, kind: "input" | "output") => `${tool}_${kind}`;

/** The repo path of the document: `schemas/` mirrors what the published origin serves. */
export function pathOf($id: string): string {
  if (!$id.startsWith(PUBLISHED_ORIGIN)) {
    throw new Error(`$id ${$id} is not under ${PUBLISHED_ORIGIN}`);
  }
  return join(REPO, "schemas", $id.slice(PUBLISHED_ORIGIN.length));
}

/** The contract document, as committed text. */
export function emit(): string {
  const tools: Record<string, unknown> = {};
  const defs: Record<string, unknown> = {};
  for (const [tool, { visibility }] of Object.entries(CONTRACT.tools)) {
    const pair = SOURCES[visibility][tool];
    if (!pair) {
      throw new Error(
        `the contract names ${visibility} tool "${tool}", which has no ${visibility} source`,
      );
    }
    const entry: Record<string, unknown> = { visibility };
    for (const kind of ["input", "output"] as const) {
      const key = defKey(tool, kind);
      entry[kind] = { $ref: `#/$defs/${key}` };
      defs[key] = JSON.parse(JSON.stringify(pair[kind]));
    }
    tools[tool] = entry;
  }
  for (const [visibility, source] of Object.entries(SOURCES)) {
    for (const tool of Object.keys(source)) {
      const declared = (CONTRACT.tools as Record<string, { visibility: Visibility } | undefined>)[
        tool
      ];
      if (declared?.visibility !== visibility) {
        throw new Error(
          `the ${visibility} source has "${tool}", which the contract does not mark ${visibility}`,
        );
      }
    }
  }
  const doc = {
    $schema: DRAFT,
    $id: CONTRACT.$id,
    title: CONTRACT.title,
    description: CONTRACT.description,
    id: CONTRACT.id,
    version: CONTRACT.version,
    cardinality: CONTRACT.cardinality,
    tools,
    errors: CONTRACT.errors,
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
  const path = pathOf(CONTRACT.$id);
  const shown = relative(process.cwd(), path);
  const text = emit();
  const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (current === text) {
    process.stdout.write(`contract document up to date (${shown})\n`);
    return;
  }
  if (!check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    process.stdout.write(`wrote ${shown}\n`);
    return;
  }
  const what =
    current === null
      ? `missing  ${shown}`
      : `stale    ${shown} (${firstDifference(current, text)})`;
  process.stderr.write(
    `${what}\n\nThe contract document is out of date with its source. Run: bun run emit:contracts\n`,
  );
  process.exit(1);
}

if (import.meta.main) main();
