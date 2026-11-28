#!/usr/bin/env bun
/**
 * Convert a connector list (a directory or file of `{servers: [ServerDetail,
 * ...]}` YAML or JSON) into the AI Catalog listing a path catalog reads
 * (ADR-0077): one bare-connector entry per server, its record inline.
 *
 *   bun run catalog:convert <connector-list-dir-or-file> <out> [--publisher <id>] [--host-name <name>]
 *
 * `<out>` is a directory (written as `<out>/ai-catalog.json`) or a `.json`
 * file. Mount the result and name it in `catalogs`:
 *
 *   { "source": "/etc/nimblebrain/catalogs/local", "policy": "available" }
 *
 * Exits 1, writing nothing, when an entry the runtime would drop is present;
 * every problem is printed. `scripts/lib/connector-list-to-ai-catalog.ts` holds
 * the conversion.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { ConnectorListError, convertConnectorList } from "./lib/connector-list-to-ai-catalog.ts";

const USAGE =
  "usage: bun run catalog:convert <connector-list-dir-or-file> <out-dir-or-file.json> [--publisher <id>] [--host-name <name>]";

/** Where `<out>` writes: itself when it names a `.json` file, else `ai-catalog.json` inside it. */
export function outputFile(out: string): string {
  return extname(out) === ".json" ? out : join(out, "ai-catalog.json");
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { publisher: { type: "string" }, "host-name": { type: "string" } },
    allowPositionals: true,
  });
  const [input, out] = positionals;
  if (!input || !out || positionals.length !== 2) {
    console.error(USAGE);
    process.exit(2);
  }
  let doc: Record<string, unknown>;
  try {
    doc = convertConnectorList(input, {
      ...(values.publisher ? { publisher: values.publisher } : {}),
      ...(values["host-name"] ? { hostName: values["host-name"] } : {}),
    });
  } catch (err) {
    if (!(err instanceof ConnectorListError)) throw err;
    console.error(`✗ ${input}: nothing written. ${err.message}`);
    process.exit(1);
  }
  const file = outputFile(out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const count = (doc.entries as unknown[]).length;
  console.log(`✓ wrote ${count} bare-connector entr${count === 1 ? "y" : "ies"} to ${file}`);
}

if (import.meta.main) main();
