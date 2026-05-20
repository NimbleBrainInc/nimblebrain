#!/usr/bin/env bun
/**
 * Lint: personal-workspace ids go through `personalWorkspaceIdFor(userId)`.
 *
 * The delegation-model refactor (Stage 1 Task 001) made
 * `personalWorkspaceIdFor` the single source of truth for the
 * `ws_user_<userId>` format. Hand-building the id in another file —
 * `"ws_user_" + userId`, `` `ws_user_${userId}` ``, etc. — invites
 * the same class of drift bugs that motivated Stage 0's
 * `check:workspace-paths` lint: a future change to the prefix or
 * format wouldn't propagate.
 *
 * What this script flags:
 *   - String literal `"ws_user_"` used as an operand in a `+` chain
 *     (`"ws_user_" + userId`).
 *   - String literal `"ws_user_"` passed to `.concat(...)`.
 *   - Template literal whose head starts with `"ws_user_"`
 *     (`` `ws_user_${userId}` ``, `` `ws_user_${userId}/foo` ``).
 *
 * What it allows:
 *   - `src/workspace/workspace-store.ts` — defines `personalWorkspaceIdFor`,
 *     the only legitimate place the format lives.
 *   - A `// lint-ok:personal-workspace-id` marker on the line
 *     immediately above the construction, for the rare future case
 *     where the helper genuinely can't be used.
 *
 * Scope: `src/**\/*.ts`. The migration script imports the helper
 * directly and so doesn't need an allowlist entry; if a future
 * migration ever needs the literal, add a `// lint-ok:` marker.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:personal-workspace-id";
const PREFIX = "ws_user_";

const ALLOWED_FILES = new Set(["workspace/workspace-store.ts"].map((f) => f.split("/").join(sep)));

interface Violation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  reason: string;
}

/** True for a string literal whose text is exactly the personal-workspace prefix. */
export function isPrefixLiteral(node: ts.Node): boolean {
  return (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === PREFIX
  );
}

/**
 * Walks a binary `+` expression and returns true iff any operand is
 * the prefix literal. Covers `"ws_user_" + userId` and
 * `someVar + "ws_user_" + suffix`.
 */
export function isPrefixInBinaryPlus(node: ts.BinaryExpression): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (isPrefixLiteral(n)) {
      found = true;
      return;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      visit(n.left);
      visit(n.right);
    }
  }
  visit(node.left);
  visit(node.right);
  return found;
}

/** True for `"ws_user_".concat(...)`. */
export function isPrefixConcat(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "concat") return false;
  return isPrefixLiteral(node.expression.expression);
}

/** True for a template literal whose head text starts with the prefix. */
export function isPrefixTemplate(
  node: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral,
): boolean {
  // No-substitution templates (`some literal`) act as plain strings; if
  // they ARE the prefix exactly that's fine because `isPrefixLiteral`
  // catches them and they require an operand to mean anything. We only
  // care about templates that interpolate.
  if (ts.isNoSubstitutionTemplateLiteral(node)) return false;
  return node.head.text.startsWith(PREFIX);
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
  const relPath = relative(SRC_ROOT, absPath);
  if (ALLOWED_FILES.has(relPath)) return;
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
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    violations.push({
      file: relative(ROOT, absPath),
      line: line + 1,
      column: character + 1,
      snippet: (src.split("\n")[line] ?? "").trim(),
      reason,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && isPrefixInBinaryPlus(node)) {
      record(node, `string concatenation with "${PREFIX}"`);
    } else if (ts.isCallExpression(node) && isPrefixConcat(node)) {
      record(node, `"${PREFIX}".concat(...)`);
    } else if (ts.isTemplateExpression(node) && isPrefixTemplate(node)) {
      record(node, `template literal beginning with "${PREFIX}"`);
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
    console.error(
      `✗ Found ${violations.length} hand-built personal-workspace id(s) in src/:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column} — ${v.reason}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "Personal workspace ids must flow through `personalWorkspaceIdFor(userId)` (src/workspace/workspace-store.ts).",
    );
    console.error(
      `Legitimate exceptions (rare) require a // ${ALLOW_MARKER} comment on the line above the construction.`,
    );
    process.exit(1);
  }

  console.log(`✓ No hand-built personal-workspace ids in ${scanned} src/ files`);
}

// Gate the side effect on direct invocation. Unit tests `import` this
// module to exercise the AST predicates above without triggering the
// full src/ scan + process.exit.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
