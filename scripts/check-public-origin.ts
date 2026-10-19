#!/usr/bin/env bun
/**
 * Lint: `publicOrigin()` is the single source of the tenant's public origin.
 *
 * "What is this tenant's public origin?" must have one answer, or values that
 * have to agree by hand drift apart and an OAuth return leg lands cross-origin.
 * `src/oauth/public-origin.ts` owns the derivation, so the raw origin env vars
 * may be read only there: it reads `NB_WEB_URL` (the dev SPA origin), and
 * nothing reads `NB_API_URL`.
 *
 * What this flags, in `src/` outside `src/oauth/public-origin.ts`, a read of
 * `NB_API_URL` or `NB_WEB_URL` off `process.env` in any of these forms:
 *   - dotted: `process.env.NB_WEB_URL`
 *   - bracket with a string literal: `process.env["NB_WEB_URL"]`
 *   - bracket with an identifier bound in the same file to that literal:
 *     `const K = "NB_WEB_URL"; process.env[K]` (the form the sanctioned file uses)
 *   - destructuring: `const { NB_WEB_URL } = process.env`
 * Use `publicOrigin()` (for vendor/OAuth callback URLs) or `webOrigin()` (for
 * user-facing SPA returns) instead.
 *
 * Allowed: `src/oauth/public-origin.ts` (the sanctioned reader), and a
 * `// lint-ok:public-origin` marker on the line above a genuinely exceptional
 * read.
 *
 * Scope: `src/**\/*.ts`. Scripts and tests are out of scope.
 *
 * Exports `findOriginEnvReads` for the self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const SRC_ROOT = join(ROOT, "src");
const ALLOW_MARKER = "lint-ok:public-origin";

/** The one sanctioned reader of the raw origin env vars, relative to `src/`. */
export const SANCTIONED_FILE = ["oauth", "public-origin.ts"].join(sep);

/** The raw origin vars `publicOrigin()` centralizes. */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(["NB_API_URL", "NB_WEB_URL"]);

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

/** `process.env`, exactly. */
function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process"
  );
}

function stringLiteralText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

/** Names of `const X = "NB_…"` bindings anywhere in the file whose value is a forbidden name. */
function forbiddenNameConstants(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const value = stringLiteralText(node.initializer);
      if (value !== undefined && FORBIDDEN_NAMES.has(value)) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** The forbidden var a node reads off `process.env`, if it reads one. */
function forbiddenRead(node: ts.Node, constants: Set<string>): boolean {
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
    return FORBIDDEN_NAMES.has(node.name.text);
  }
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
    const arg = node.argumentExpression;
    const literal = stringLiteralText(arg);
    if (literal !== undefined) return FORBIDDEN_NAMES.has(literal);
    return ts.isIdentifier(arg) && constants.has(arg.text);
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer &&
    isProcessEnv(node.initializer)
  ) {
    return node.name.elements.some((el) => {
      const key = el.propertyName ?? el.name;
      const text = ts.isIdentifier(key) ? key.text : stringLiteralText(key);
      return text !== undefined && FORBIDDEN_NAMES.has(text);
    });
  }
  return false;
}

/**
 * Every forbidden origin-env read in one file's text. `relPath` is relative to
 * `src/`; the sanctioned file reports nothing.
 */
export function findOriginEnvReads(relPath: string, text: string): Violation[] {
  if (relPath === SANCTIONED_FILE) return [];
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const constants = forbiddenNameConstants(sf);
  const lines = text.split("\n");
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (forbiddenRead(node, constants)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const prev = (lines[line - 1] ?? "").trim();
      if (!prev.includes(ALLOW_MARKER)) {
        violations.push({ file: relPath, line: line + 1, snippet: (lines[line] ?? "").trim() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
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
    for (const v of findOriginEnvReads(relative(SRC_ROOT, abs), readFileSync(abs, "utf-8"))) {
      violations.push({ ...v, file: relative(ROOT, abs) });
    }
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} raw public-origin env read(s) in src/:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.snippet}\n`);
    }
    console.error(
      "The public origin is derived in `src/oauth/public-origin.ts`. Use `publicOrigin()`",
    );
    console.error(
      "for vendor/OAuth callback URLs or `webOrigin()` for user-facing SPA returns — not raw",
    );
    console.error(
      `NB_API_URL / NB_WEB_URL. Rare exceptions need a // ${ALLOW_MARKER} comment above.`,
    );
    process.exit(1);
  }

  console.log(`✓ No raw public-origin env reads in ${scanned} src/ files`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
