#!/usr/bin/env bun
/**
 * Lint: every URI scheme this runtime resolves itself is named in
 * `RESERVED_RESOURCE_SCHEMES` (`src/tools/resource-schemes.ts`).
 *
 * That set is what `parseNotificationsDeclaration` refuses an outbox against,
 * so a scheme missing from it is a scheme a server may claim for an outbox
 * while the host also resolves it — one URI carrying two meanings, decided by
 * whichever reader gets there first. The set has to be **complete** or the
 * refusal is decorative, and completeness is exactly the property a doc comment
 * cannot hold: it was wrong twice in review before this check existed, once for
 * `artifact://` and `files://` and once for `app://`.
 *
 * The rule is not "these schemes are forbidden" — it is "a scheme appearing in
 * `src/` has been classified". Every hit resolves to one of two lists, and
 * adding either entry is the decision this lint exists to force:
 *
 *   - {@link RESERVED_RESOURCE_SCHEMES} — the host resolves it, so an outbox
 *     may not land on it.
 *   - {@link NOT_HOST_RESOLVED} below — the runtime only ever *speaks* it
 *     outward (fetching a URL, say). Nothing in the host answers it, so it
 *     collides with nothing.
 *
 * What it scans, and why both shapes are needed: string and template literals
 * carrying `<scheme>://` catch a scheme written out (`"artifact://"`,
 * `` `app://instructions` ``), and a `*_URI_SCHEME` constant catches one whose
 * only literal spelling is the bare name (`FILE_URI_SCHEME = "files"`, whose
 * `files://` form exists only as a template). Checking one shape alone misses
 * half the population — the `files://` regression was invisible to a literal
 * scan, and the `app://` one to a constant scan.
 *
 * Scope: `src/**\/*.ts`, minus vendored trees. Comments are not scanned — the
 * AST walk sees literals only, so prose naming a scheme is free. Tests live
 * outside `src/` and are out of scope; a fixture naming an unclassified scheme
 * is the point of a fixture. `node_modules` under each bundle's `ui/` is
 * skipped for the same reason the sibling lints skip it: it is gitignored,
 * local-only, and full of other people's URI grammars.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";
import { RESERVED_RESOURCE_SCHEMES } from "../src/tools/resource-schemes.ts";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");

/**
 * Schemes the runtime only ever speaks outward — it fetches these, nothing in
 * the host answers them, so no declared resource can collide with one.
 *
 * A scheme belongs here only when the host resolves *nothing* at it. If the
 * host would answer the URI, it is reserved instead, and putting it here to
 * quiet the lint reopens the collision the refusal exists to close.
 */
const NOT_HOST_RESOLVED = new Set(["http", "https"]);

/** `<scheme>://`, anchored so a `//` inside a path can't be read as the start of one. */
const SCHEME_IN_URI_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\//g;

/** A constant naming a scheme by its bare name: `const FILE_URI_SCHEME = "files"`. */
const SCHEME_CONST_RE = /_URI_SCHEME$/;

interface Violation {
  file: string;
  line: number;
  scheme: string;
  snippet: string;
}

const classified = new Set<string>([
  ...(RESERVED_RESOURCE_SCHEMES as readonly string[]),
  ...NOT_HOST_RESOLVED,
]);

const violations: Violation[] = [];

/** Record `scheme` when it is in neither list, attributing it to `node`'s line. */
function classify(scheme: string, node: ts.Node, sf: ts.SourceFile, snippet: string) {
  if (classified.has(scheme.toLowerCase())) return;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  violations.push({
    file: relative(ROOT, sf.fileName),
    line: line + 1,
    scheme,
    snippet: snippet.trim().slice(0, 120),
  });
}

/** Walk one file's literals and scheme constants. */
function scanFile(fileName: string) {
  const sf = ts.createSourceFile(
    fileName,
    readFileSync(fileName, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const visit = (node: ts.Node) => {
    // Shape 1: a scheme spelled inside a literal — "artifact://x", `app://instructions`.
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const m of node.text.matchAll(SCHEME_IN_URI_RE)) {
        classify(m[1]!, node, sf, node.text);
      }
    }

    // Shape 2: a scheme held as a bare name — `const FILE_URI_SCHEME = "files"`.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      SCHEME_CONST_RE.test(node.name.text) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      classify(node.initializer.text, node, sf, node.getText(sf));
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
}

function main() {
  let scanned = 0;
  for (const rel of new Glob("**/*.ts").scanSync(SRC_ROOT)) {
    if (rel.split(/[\\/]/).includes("node_modules")) continue;
    scanFile(join(SRC_ROOT, rel));
    scanned++;
  }

  if (violations.length > 0) {
    console.error(`\n✗ ${violations.length} unclassified URI scheme(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.scheme}://`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Every scheme in src/ has to be classified, because RESERVED_RESOURCE_SCHEMES is what",
    );
    console.error(
      "a declared outbox is refused against — a scheme missing from it is one a server can",
    );
    console.error("claim while the host also resolves it. Add it to one of:");
    console.error("  - RESERVED_RESOURCE_SCHEMES (src/tools/resource-schemes.ts) — host-resolved.");
    console.error(
      "  - NOT_HOST_RESOLVED (this file) — the runtime only speaks it outward; nothing answers it.",
    );
    process.exit(1);
  }

  console.log(
    `✓ ${classified.size} classified URI schemes, no unclassified spelling across ${scanned} src/ files`,
  );
}

// Gate the scan on direct invocation, matching the sibling check scripts, so
// importing this module never runs it or calls process.exit.
if (import.meta.main) {
  main();
}
