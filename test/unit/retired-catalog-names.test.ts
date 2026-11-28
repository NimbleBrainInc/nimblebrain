/**
 * The pre-record catalog machinery is retired (ADR-0077, "Retired"): the
 * zip-scanning skill and starter resolver, the bound-skill reconcile, the
 * image-compiled pins and their environment, and the connector list as a
 * runtime input. Nothing in the tree names them again, so a reader finds no
 * path to a mechanism that no longer runs. The CHANGELOG and the ADRs record
 * them as history and are not read.
 */

import { describe, expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Each retired name, matched as a whole word. */
const RETIRED = [
  "resolveServerSkills",
  "resolveServerConversationStarters",
  "connector-skill-resolver",
  "connector-skill-reconcile",
  "bootReconcileConnectorSkills",
  "reconcileConnectorSkills",
  "syncBoundSkills",
  "setConnectorSkillFetch",
  "bindSkills",
  "PLUGIN_CATALOG_SHA256_DEFAULT",
  "PLUGIN_CATALOG_CONNECTORS_SHA256_DEFAULT",
  "NB_PLUGIN_CATALOG_SHA256",
  "NB_PLUGIN_CATALOG_CONNECTORS_SHA256",
  "connectorsSha256",
  "resolvePluginCatalogConfig",
  "loadPinnedConnectors",
  "catalogLocation",
  "warnIfCatalogEmpty",
  "listingById",
  "NB_CURATED_CATALOG_DIR",
];

/** What is searched: the code, its tests, its docs and its operator-facing files. */
const ROOTS = [
  "src",
  "test",
  "scripts",
  "web/src",
  "packages",
  "schemas",
  "contracts",
  "docs/src",
  "AGENTS.md",
  "CONTEXT.md",
  "README.md",
  "Dockerfile",
  "docker-compose.yml",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", "_generated"]);
const TEXT = /\.(ts|tsx|js|mjs|json|md|mdx|ya?ml|sh)$|Dockerfile$/;
const SELF = relative(ROOT, import.meta.path);

function* files(path: string): Generator<string> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (TEXT.test(path)) yield path;
    return;
  }
  // A symlink (each `CLAUDE.md`) is its target's second name, read where the target is.
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    yield* files(join(path, entry.name));
  }
}

describe("the retired catalog machinery", () => {
  test("no file names a retired symbol, module or environment variable", () => {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_-])(${RETIRED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`,
    );
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const path of files(join(ROOT, root))) {
        const rel = relative(ROOT, path);
        if (rel === SELF) continue;
        const lines = readFileSync(path, "utf-8").split("\n");
        lines.forEach((line, i) => {
          const match = pattern.exec(line);
          if (match) hits.push(`${rel}:${i + 1}: ${match[1]}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
