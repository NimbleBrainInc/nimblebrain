#!/usr/bin/env bun
/**
 * Lint: a Hono sub-app chains its middleware on each route, never with `.use()`.
 *
 * `app.ts` mounts every router at "/", and Hono flattens a sub-app's
 * `.use("*", mw)` into a `/*` matcher on the parent. That middleware then runs
 * for every request the parent handles after the mount: an unregistered path
 * answers 401 instead of 404, and a route mounted later runs another router's
 * `requireAuth` and `errorLog`. Middleware chained on the route
 * (`.get(path, requireAuth(...), handler)`) runs for that route alone.
 *
 * What this script flags: any `<expr>.use(...)` call in a file under `src/`
 * that imports from `hono`, except `src/api/app.ts`, whose global middleware
 * (tracing, metrics, CORS, security headers, the cross-site guard) is
 * app-wide by design. Rule and examples: CODE_STYLE.md, "Router middleware
 * is chained per route".
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");

/** The one Hono app whose `.use()` is global by design, relative to the repo root. */
const APP_FILE = ["src", "api", "app.ts"].join(sep);

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function importsHono(source: ts.SourceFile): boolean {
  return source.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      (s.moduleSpecifier.text === "hono" || s.moduleSpecifier.text.startsWith("hono/")),
  );
}

/** Every `.use(...)` call in one sub-app source file. */
export function findSubAppUse(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (!importsHono(source)) return [];
  const lines = text.split("\n");
  const violations: Violation[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "use"
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.expression.name.getStart(source));
      violations.push({ file, line: line + 1, snippet: (lines[line] ?? "").trim() });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

/** Scan `<root>/src` for sub-app `.use()` calls. Paths in the result are relative to `root`. */
export function scan(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const rel of new Glob("**/*.ts").scanSync({ cwd: join(root, "src") })) {
    const file = join("src", rel);
    if (file === APP_FILE) continue;
    if (file.split(sep).includes("node_modules") || file.endsWith(".d.ts")) continue;
    violations.push(...findSubAppUse(file, readFileSync(join(root, file), "utf-8")));
  }
  return violations;
}

if (import.meta.main) {
  const violations = scan(process.argv[2] ?? ROOT);
  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} sub-app .use() call(s):\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    console.error(
      '\nChain the middleware on each route instead: .get(path, requireAuth(...), handler). A sub-app\'s .use("*") runs for every request the parent app handles. See CODE_STYLE.md.',
    );
    process.exit(1);
  }
  console.log("✓ No sub-app .use() calls");
}
