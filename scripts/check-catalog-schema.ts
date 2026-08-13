#!/usr/bin/env bun
/**
 * Schema gate for a connector catalog.
 *
 * Takes a catalog path (a `ServerDetail` file or a directory of them)
 * and reports every entry the runtime would silently drop: one that
 * fails the upstream `ServerDetail` schema, duplicates a name already
 * claimed by an earlier file, sits in a file that cannot be read or
 * parsed, or is scrubbed at the directory boundary for an unsafe URL or
 * a reserved OAuth param. Exit 1 if anything would be dropped, 0 if the
 * whole catalog reaches the catalog intact.
 *
 * **Why this exists.** A catalog entry is validated at load, and an
 * invalid one is dropped with a warn log while its siblings load fine
 * — so the connector simply never appears in Browse, with no hard
 * failure anywhere. The catalog is deployment-managed config, edited in
 * a repo that does not compile against this schema, which means a
 * malformed entry merges green and fails only in a running tenant. That
 * exact failure has shipped four times, always on `description`, which
 * upstream caps at 100 characters.
 *
 * It runs the real `validateStaticCatalog` rather than a second
 * validator, so the gate cannot drift from what production does — if
 * this passes, the runtime keeps every entry.
 *
 * Offline and deterministic, unlike its sibling
 * `check-catalog-dcr.ts`, which probes vendor OAuth endpoints over the
 * network. This one is safe to run on every PR that touches a catalog.
 *
 *   bun run scripts/check-catalog-schema.ts <catalog-file-or-dir>
 *   bun run check:catalog-schema          # the in-repo example catalog
 */

import { validateStaticCatalog } from "../src/registries/static-source.ts";

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun run scripts/check-catalog-schema.ts <catalog-file-or-dir>");
    process.exit(2);
  }

  const diagnostics = validateStaticCatalog(path);
  if (diagnostics.length === 0) {
    console.log(`✓ ${path}: every entry reaches the catalog (schema + safety)`);
    return;
  }

  console.error(`✗ ${path}: ${diagnostics.length} problem(s) — these entries would be dropped\n`);
  // Print the diagnostic verbatim. It is already file-and-entry
  // qualified, and it is the same sentence the runtime logs — so this
  // output is the string to grep for when confirming the fix landed in
  // a running tenant.
  for (const d of diagnostics) console.error(`  ${d.message}`);
  // Only entry-level problems have an entry to go fix. A missing path or
  // an unparseable file has no `index`, and telling that operator about
  // field rules would point them at the wrong thing entirely.
  if (diagnostics.some((d) => d.index !== undefined)) {
    console.error(
      "\nA dropped entry does not fail at runtime — the connector just never appears.\n" +
        "Field rules: `description` is capped at 100 characters by the upstream MCP\n" +
        "registry schema (src/connectors/schemas/server.schema.json); icon, docs, and\n" +
        "portal URLs must be http(s), and OAuth params may not use reserved keys.",
    );
  }
  process.exit(1);
}

// Only run when invoked directly, so the module can be imported without
// tripping the argv reads and the process.exit calls.
if (import.meta.main) {
  main();
}
