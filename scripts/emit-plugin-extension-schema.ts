#!/usr/bin/env bun
/**
 * Emit the `ai.nimblebrain` plugin extension's JSON Schema from its TypeBox
 * source (`src/plugins/extension.ts`).
 *
 *   bun --no-env-file scripts/emit-plugin-extension-schema.ts           # write
 *   bun --no-env-file scripts/emit-plugin-extension-schema.ts --check   # verify
 *
 * The JSON (`schemas/plugin-extension/v1/plugin-extension.schema.json`) is the
 * published form, served at its `$id`, and the one the loader validates
 * against. `--check` writes nothing and exits 1 when the committed file is
 * missing or differs from what the source emits.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
  PLUGIN_EXTENSION_SCHEMA_FILE,
  pluginExtensionJsonSchema,
} from "../src/plugins/extension.ts";

function main(): void {
  const text = `${JSON.stringify(pluginExtensionJsonSchema(), null, 2)}\n`;
  const shown = relative(process.cwd(), PLUGIN_EXTENSION_SCHEMA_FILE);
  if (!process.argv.includes("--check")) {
    mkdirSync(dirname(PLUGIN_EXTENSION_SCHEMA_FILE), { recursive: true });
    writeFileSync(PLUGIN_EXTENSION_SCHEMA_FILE, text);
    process.stdout.write(`wrote ${shown}\n`);
    return;
  }
  const committed = existsSync(PLUGIN_EXTENSION_SCHEMA_FILE)
    ? readFileSync(PLUGIN_EXTENSION_SCHEMA_FILE, "utf-8")
    : null;
  if (committed !== text) {
    process.stderr.write(
      `${shown} is ${committed === null ? "missing" : "out of date"} with src/plugins/extension.ts. ` +
        "Run: bun run emit:plugin-extension\n",
    );
    process.exit(1);
  }
  process.stdout.write("plugin extension schema up to date\n");
}

if (import.meta.main) main();
