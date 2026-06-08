#!/usr/bin/env bun
/**
 * Lint: project-specific code-style rules.
 *
 * The rules themselves are documented in `CODE_STYLE.md` at the repo
 * root. This script enforces them — one detection pass per rule,
 * aggregated into a single pass/fail so all violations surface in one
 * run instead of one-at-a-time across re-runs.
 *
 * Adding a new rule:
 *   1. Document the rule in `CODE_STYLE.md` (anti-example, good example,
 *      rationale).
 *   2. Add a new check function below following the existing pattern —
 *      walk source files, collect violations, return a string array of
 *      formatted findings.
 *   3. Add the new check to `checks` in `main()`.
 *
 * Scope: `src/**\/*.ts` only. Tests and bundles are out of scope
 * (tests deliberately exercise edge cases; bundles run in subprocesses
 * with their own conventions).
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");

interface CheckResult {
  rule: string;
  violations: string[];
}

/**
 * Rule: No inline type imports.
 *
 * Pattern: `import("path").TypeName` in a type position. Equivalent to
 * top-level `import type { TypeName } from "path"` at compile time,
 * but reads as a runtime dynamic import and trips readers.
 *
 * Detection: TypeScript AST walk for `ImportTypeNode`. The AST kind
 * `ts.SyntaxKind.ImportType` is precisely the inline-type-import shape
 * — runtime dynamic imports (`await import("...")`) parse as
 * `CallExpression` and are not caught. AST-level matching avoids
 * regex false-positives.
 */
function checkNoInlineTypeImports(): CheckResult {
  const violations: string[] = [];
  const glob = new Glob("**/*.ts");

  for (const file of glob.scanSync({ cwd: SRC_ROOT, absolute: true })) {
    // Never lint vendored dependencies. Some bundle UIs install their own
    // node_modules under src/bundles/<name>/ui/ (gitignored, local-only);
    // those third-party .d.ts files are full of inline type imports we
    // don't own, and they don't exist in CI's fresh checkout — so without
    // this skip the check passes in CI but fails on a developer's machine.
    if (file.split(/[\\/]/).includes("node_modules")) continue;
    const rel = relative(ROOT, file);
    // Skip bundle subtrees (their UIs have their own conventions, per the
    // doc comment) and vendored deps. `bun run build:bundles` installs
    // node_modules under each bundle's UI, so an unfiltered walk picks
    // up thousands of vendored `.d.ts` violations that have nothing to
    // do with our source.
    if (rel.includes("/node_modules/")) continue;
    if (rel.startsWith("src/bundles/")) continue;
    const content = readFileSync(file, "utf-8");
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node): void {
      if (ts.isImportTypeNode(node)) {
        const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart());
        // Walk up to find the enclosing statement so the formatted
        // finding includes useful context.
        const lineText = content.split("\n")[line]?.trim() ?? "";
        violations.push(`  ${rel}:${line + 1}  ${lineText}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  return { rule: "no-inline-type-imports", violations };
}

function main(): void {
  const checks: CheckResult[] = [checkNoInlineTypeImports()];

  let totalViolations = 0;
  for (const { rule, violations } of checks) {
    if (violations.length === 0) {
      console.log(`  ✓ ${rule}: clean`);
      continue;
    }
    totalViolations += violations.length;
    console.error(`  × ${rule}: ${violations.length} violation(s)`);
    console.error("    See CODE_STYLE.md for the rule and refactor guidance.");
    for (const v of violations) console.error(v);
  }

  if (totalViolations > 0) {
    console.error(`\n${totalViolations} code-style violation(s) total.`);
    process.exit(1);
  }
}

main();
