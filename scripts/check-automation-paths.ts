#!/usr/bin/env bun
/**
 * Lint: automations are workspace-owned and reached through one constructor.
 *
 * Automations live under the workspace that owns them, with the owner as a
 * privacy sub-partition (`{workDir}/workspaces/<wsId>/automations/<ownerId>/`).
 * The dir is built only by `workspaceAutomationsDir()` in
 * `src/bundles/automations/src/paths.ts`. Two regressions are forbidden in
 * `src/`:
 *
 *   1. `getIdentityContext(...).getDataPath("automations")` /
 *      `new IdentityContext(...).getDataPath("automations")` — reaching the
 *      legacy identity-owned automations dir (`users/<userId>/automations`).
 *      The owning WORKSPACE, not the caller's identity, decides where an
 *      automation lives.
 *   2. `join(..., "users", X, "automations")` — a hand-built identity-scoped
 *      automations dir, the exact shape the workspace migration removes.
 *
 * Allowed: a `// lint-ok:automation-path` marker on a line just above the call,
 * for the rare future case the constructor genuinely can't cover.
 *
 * Scope: `src/**\/*.ts`. Tests and `scripts/` are out of scope (the migration
 * deliberately reads the old identity-scoped layout).
 *
 * Exports its AST predicates for the self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:automation-path";

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  return ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
}

/**
 * True iff `expr` produces an `IdentityContext` directly — a call to
 * `getIdentityContext(...)` / `x.getIdentityContext(...)`, or a
 * `new IdentityContext(...)` / `IdentityContext(...)` construction.
 */
function chainsFromIdentityContext(expr: ts.Expression): boolean {
  if (ts.isCallExpression(expr)) {
    const name = calleeName(expr);
    return name === "getIdentityContext" || name === "IdentityContext";
  }
  if (ts.isNewExpression(expr)) {
    const target = expr.expression;
    const name = ts.isIdentifier(target)
      ? target.text
      : ts.isPropertyAccessExpression(target)
        ? target.name.text
        : null;
    return name === "IdentityContext" || name === "getIdentityContext";
  }
  return false;
}

/**
 * True iff `node` is `<identityCtx>.getDataPath("automations", ...)` — reaching
 * the legacy identity-owned automations dir. Matches only when the
 * `getDataPath` receiver chains directly from `getIdentityContext`/
 * `IdentityContext` and the first argument is the string literal `"automations"`.
 */
export function isIdentityAutomationsDataPath(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "getDataPath") return false;
  const first = node.arguments[0];
  const firstIsAutomations =
    first !== undefined &&
    (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
    first.text === "automations";
  if (!firstIsAutomations) return false;
  return chainsFromIdentityContext(callee.expression);
}

/**
 * True iff `node` is `join(..., "users", ..., "automations")` — a hand-built
 * identity-scoped automations dir. Matches a `join(...)` call whose string-
 * literal arguments include BOTH `"users"` and `"automations"`.
 */
export function isUsersScopedAutomationsJoin(node: ts.CallExpression): boolean {
  if (calleeName(node) !== "join") return false;
  const literals = node.arguments
    .filter(
      (a): a is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
        ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a),
    )
    .map((a) => a.text);
  return literals.includes("users") && literals.includes("automations");
}

function hasAllowMarker(node: ts.Node, sourceFile: ts.SourceFile, src: string): boolean {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  if (line === 0) return false;
  const lines = src.split("\n");
  for (let i = line - 1; i >= Math.max(0, line - 5); i--) {
    const lineText = lines[i] ?? "";
    if (lineText.includes(ALLOW_MARKER)) return true;
    const trimmed = lineText.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue;
    }
    return false;
  }
  return false;
}

function scanFile(absPath: string, violations: Violation[]): void {
  const src = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    absPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function record(node: ts.Node, reason: string): void {
    if (hasAllowMarker(node, sourceFile, src)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: relative(ROOT, absPath),
      line: line + 1,
      column: character + 1,
      snippet: (src.split("\n")[line] ?? "").trim(),
      reason,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (isIdentityAutomationsDataPath(node)) {
        record(
          node,
          'getIdentityContext(...).getDataPath("automations") — automations are workspace-owned; use workspaceAutomationsDir()',
        );
      } else if (isUsersScopedAutomationsJoin(node)) {
        record(
          node,
          'join(..., "users", ..., "automations") — identity-scoped dir; use workspaceAutomationsDir()',
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.ts");
  let scanned = 0;

  for await (const rel of glob.scan({ cwd: SRC_ROOT })) {
    const abs = join(SRC_ROOT, rel);
    if (abs.includes("/node_modules/") || abs.includes("/dist/")) continue;
    if (abs.endsWith(".d.ts")) continue;
    scanned++;
    scanFile(abs, violations);
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} identity-owned automations path(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Automations are workspace-owned at `{workDir}/workspaces/<wsId>/automations/<ownerId>/` — build the",
    );
    console.error(
      "dir only via `workspaceAutomationsDir()` (src/bundles/automations/src/paths.ts).",
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above.`,
    );
    process.exit(1);
  }

  console.log(`✓ No identity-owned automations paths in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
