#!/usr/bin/env bun
/**
 * Emit the `ai.nimblebrain` plugin extension's JSON Schema from its TypeBox
 * source (`src/plugins/extension.ts`).
 *
 *   bun --no-env-file scripts/emit-plugin-extension-schema.ts           # write
 *   bun --no-env-file scripts/emit-plugin-extension-schema.ts --check   # verify
 *
 * The JSON (`src/plugins/schemas/plugin-extension.schema.json`) is the
 * published form and the one the loader validates against. `--check` compares
 * it with what the source emits as parsed JSON, so Biome's formatting of the
 * committed file is not drift, and exits 1 when they differ.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pluginExtensionJsonSchema } from "../src/plugins/extension.ts";

const TARGET = resolve(import.meta.dir, "../src/plugins/schemas/plugin-extension.schema.json");

function main(): void {
  const emitted = pluginExtensionJsonSchema();
  const shown = relative(process.cwd(), TARGET);
  if (!process.argv.includes("--check")) {
    writeFileSync(TARGET, `${JSON.stringify(emitted, null, 2)}\n`);
    process.stdout.write(`wrote ${shown}\n`);
    return;
  }
  const committed = existsSync(TARGET) ? JSON.parse(readFileSync(TARGET, "utf-8")) : null;
  if (!isDeepStrictEqual(committed, emitted)) {
    process.stderr.write(
      `${shown} is ${committed === null ? "missing" : "out of date"} with src/plugins/extension.ts. ` +
        "Run: bun run emit:plugin-extension && bun run format\n",
    );
    process.exit(1);
  }
  process.stdout.write("plugin extension schema up to date\n");
}

if (import.meta.main) main();
