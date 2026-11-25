#!/usr/bin/env bun
/**
 * Emit the conversations contract's JSON Schemas from their TypeBox authoring
 * sources.
 *
 *   bun --no-env-file contracts/conversations/scripts/emit-schemas.ts           # write
 *   bun --no-env-file contracts/conversations/scripts/emit-schemas.ts --check   # verify
 *
 * The JSON under `schemas/` is the published contract and is committed. TypeBox
 * is only where it is authored: `src/platform/schemas/conversations.ts` for the
 * public tools (today's conversations tools are the public tools), and
 * `../source/private.ts` for the private tools. This script is build tooling; it
 * is the one place in `contracts/` that reads an authoring source under `src/`.
 *
 * Each file is the schema exactly as it travels in `tools/list` (a JSON round
 * trip, which drops TypeBox's symbol-keyed metadata), with `$schema` (draft
 * 2020-12) and `$id` added at the root. `$id` sits under the contract's derived
 * location, major only:
 * `https://schemas.nimblebrain.ai/contracts/<id>/<major>/<tool>.<kind>.json`.
 * Each tool's source must match its visibility in `contract.json`.
 *
 * `--check` writes nothing. It exits 1 when a committed file is missing,
 * differs from what would be emitted, or is left over from a tool that no
 * longer exists, and prints one line per file with the first differing line.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import * as App from "../../../src/platform/schemas/conversations.ts";
import { PRIVATE_SCHEMAS } from "../source/private.ts";

const ROOT = resolve(import.meta.dir, "..");
const SCHEMAS_DIR = join(ROOT, "schemas");
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

interface ContractFile {
  id: string;
  version: string;
  tools: Record<string, { visibility: "public" | "private" }>;
}

type ToolSchemas = Record<string, { input: TSchema; output: TSchema }>;

const PUBLIC_SCHEMAS: ToolSchemas = {
  list: { input: App.ConversationsListInput, output: App.ConversationsListOutput },
  get: { input: App.ConversationsGetInput, output: App.ConversationsGetOutput },
  search: { input: App.ConversationsSearchInput, output: App.ConversationsSearchOutput },
  update: { input: App.ConversationsUpdateInput, output: App.ConversationsUpdateOutput },
  stats: { input: App.ConversationsStatsInput, output: App.ConversationsStatsOutput },
  export: { input: App.ConversationsExportInput, output: App.ConversationsExportOutput },
};

const SOURCES: Record<"public" | "private", ToolSchemas> = {
  public: PUBLIC_SCHEMAS,
  private: PRIVATE_SCHEMAS,
};

/** The contract's derived location: `https://schemas.nimblebrain.ai/contracts/<id>/<major>/`. */
export function locationOf(contract: Pick<ContractFile, "id" | "version">): string {
  const major = contract.version.split(".")[0];
  return `https://schemas.nimblebrain.ai/contracts/${contract.id}/${major}/`;
}

/** Every file the contract's schemas consist of, keyed by path relative to `schemas/`. */
export function emit(contract: ContractFile): Map<string, string> {
  const base = locationOf(contract);
  const files = new Map<string, string>();
  for (const [tool, { visibility }] of Object.entries(contract.tools)) {
    const pair = SOURCES[visibility]?.[tool];
    if (!pair) {
      throw new Error(
        `contract.json names ${visibility} tool "${tool}", which has no ${visibility} source`,
      );
    }
    for (const kind of ["input", "output"] as const) {
      const rel = `${tool}.${kind}.json`;
      const wire = JSON.parse(JSON.stringify(pair[kind])) as Record<string, unknown>;
      const json = { $schema: DRAFT, $id: `${base}${rel}`, ...wire };
      files.set(rel, `${JSON.stringify(json, null, 2)}\n`);
    }
  }
  for (const [visibility, tools] of Object.entries(SOURCES)) {
    for (const tool of Object.keys(tools)) {
      if (contract.tools[tool]?.visibility !== visibility) {
        throw new Error(
          `the ${visibility} source has "${tool}", which contract.json does not mark ${visibility}`,
        );
      }
    }
  }
  return files;
}

function committedFiles(): Set<string> {
  const out = new Set<string>();
  if (!existsSync(SCHEMAS_DIR)) return out;
  for (const f of readdirSync(SCHEMAS_DIR, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".json")) out.add(f.name);
  }
  return out;
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

interface Drift {
  kind: "missing" | "stale" | "extra";
  rel: string;
  /** The emitted text, for a missing or stale file. */
  text?: string;
  /** Where the committed file first differs, for a stale one. */
  where?: string;
}

/** Every committed file that differs from what the source emits. */
export function driftOf(files: Map<string, string>): Drift[] {
  const drift: Drift[] = [];
  for (const [rel, text] of files) {
    const path = join(SCHEMAS_DIR, rel);
    const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (current === null) drift.push({ kind: "missing", rel, text });
    else if (current !== text) {
      drift.push({ kind: "stale", rel, text, where: firstDifference(current, text) });
    }
  }
  for (const rel of committedFiles()) {
    if (!files.has(rel)) drift.push({ kind: "extra", rel });
  }
  return drift;
}

const shown = (rel: string) => relative(process.cwd(), join(SCHEMAS_DIR, rel));

function describe(d: Drift): string {
  if (d.kind === "missing") return `missing  ${shown(d.rel)}`;
  if (d.kind === "stale") return `stale    ${shown(d.rel)} (${d.where})`;
  return `extra    ${shown(d.rel)} (no tool in the source emits it)`;
}

function apply(d: Drift): void {
  const path = join(SCHEMAS_DIR, d.rel);
  if (d.kind === "extra") {
    rmSync(path);
    process.stdout.write(`removed ${shown(d.rel)}\n`);
    return;
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, d.text ?? "");
  process.stdout.write(`wrote ${shown(d.rel)}\n`);
}

function main(): void {
  const check = process.argv.includes("--check");
  const contract = JSON.parse(readFileSync(join(ROOT, "contract.json"), "utf-8")) as ContractFile;
  const files = emit(contract);
  const drift = driftOf(files);
  if (!check) {
    for (const d of drift) apply(d);
    return;
  }
  if (drift.length > 0) {
    process.stderr.write(
      `${drift.map(describe).join("\n")}\n\n${drift.length} contract schema file(s) out of date ` +
        "with their TypeBox source. Run: bun run emit:contracts\n",
    );
    process.exit(1);
  }
  process.stdout.write(`contract schemas up to date (${files.size} files)\n`);
}

if (import.meta.main) main();
