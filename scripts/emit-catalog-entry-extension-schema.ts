#!/usr/bin/env bun
/**
 * Emit the `ai.nimblebrain` catalog-entry extension's JSON Schema from its
 * TypeBox source (`src/catalogs/entry-extension.ts`).
 *
 *   bun --no-env-file scripts/emit-catalog-entry-extension-schema.ts           # write
 *   bun --no-env-file scripts/emit-catalog-entry-extension-schema.ts --check   # verify
 *
 * The JSON (`schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json`)
 * is the published form, served at its `$id`, and the one the catalog reader
 * validates against. `--check` writes nothing and exits 1 when the committed
 * file is missing or differs from what the source emits.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
  CATALOG_ENTRY_EXTENSION_SCHEMA_FILE,
  catalogEntryExtensionJsonSchema,
} from "../src/catalogs/entry-extension.ts";

function main(): void {
  const text = `${JSON.stringify(catalogEntryExtensionJsonSchema(), null, 2)}\n`;
  const file = CATALOG_ENTRY_EXTENSION_SCHEMA_FILE;
  const shown = relative(process.cwd(), file);
  if (!process.argv.includes("--check")) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    process.stdout.write(`wrote ${shown}\n`);
    return;
  }
  const committed = existsSync(file) ? readFileSync(file, "utf-8") : null;
  if (committed !== text) {
    process.stderr.write(
      `${shown} is ${committed === null ? "missing" : "out of date"} with src/catalogs/entry-extension.ts. ` +
        "Run: bun run emit:catalog-entry-extension\n",
    );
    process.exit(1);
  }
  process.stdout.write("catalog-entry extension schema up to date\n");
}

if (import.meta.main) main();
