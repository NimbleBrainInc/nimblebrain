#!/usr/bin/env bun
/**
 * Lint: an HTTP route writes a JSON body only through `json<T>()`, with `T`
 * a named type from `src/api/schemas/responses.ts`.
 *
 * A route's body is a contract the web shell and the tests read. Written
 * inline, it is described again by each reader, and those copies drift from the
 * handler the first time it changes. `json<T>()` (`src/api/types.ts`) does not
 * compile without `T`; this script closes the ways around it.
 *
 * What this script flags, in any `.ts` file under `src/` outside the platform
 * app UI packages:
 *
 * - a `.json(...)` call with an argument: Hono's `c.json(body)` and
 *   `Response.json(body)` (reading a body, `res.json()`, takes none);
 * - `new Response(JSON.stringify(...))`, except inside `src/api/types.ts`,
 *   where `json` itself is defined;
 * - a `json<T>(...)` call whose `T` is not a name imported from
 *   `schemas/responses.ts`, such as an inline `json<{ ok: boolean }>`.
 *
 * Rule and examples: CODE_STYLE.md, "A route's JSON body is a named response
 * type".
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");

/** Where `json` is defined: its own `new Response(JSON.stringify(...))` is the one allowed. */
const HELPER_FILE = ["src", "api", "types.ts"].join(sep);

/** The module every response type is imported from. */
const RESPONSES_MODULE = /(^|\/)schemas\/responses\.ts$/;

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

/** Names this file imports from `schemas/responses.ts`. */
function responseTypeNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (!RESPONSES_MODULE.test(s.moduleSpecifier.text)) continue;
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text);
    }
  }
  return names;
}

function isJsonStringifyCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON" &&
    node.expression.name.text === "stringify"
  );
}

/** Why `node` writes a JSON body outside the contract, or null when it does not. */
function violationOf(node: ts.Node, file: string, allowed: Set<string>): string | null {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "json" &&
      node.arguments.length > 0
    ) {
      return "writes a JSON body with .json(...)";
    }
    if (ts.isIdentifier(callee) && callee.text === "json" && node.typeArguments?.length === 1) {
      const arg = node.typeArguments[0]!;
      const named =
        ts.isTypeReferenceNode(arg) &&
        ts.isIdentifier(arg.typeName) &&
        allowed.has(arg.typeName.text);
      if (!named) return "json<T> with a T not imported from schemas/responses.ts";
    }
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Response" &&
    node.arguments?.[0] &&
    isJsonStringifyCall(node.arguments[0]) &&
    file !== HELPER_FILE
  ) {
    return "writes a JSON body with new Response(JSON.stringify(...))";
  }
  return null;
}

/** Every JSON body in one source file written outside `json<NamedType>()`. */
export function findUntypedJson(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const allowed = responseTypeNames(source);
  const lines = text.split("\n");
  const violations: Violation[] = [];
  function visit(node: ts.Node): void {
    if (violationOf(node, file, allowed)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({ file, line: line + 1, snippet: (lines[line] ?? "").trim() });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

/** Scan `<root>/src`. Paths in the result are relative to `root`. */
export function scan(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const rel of new Glob("**/*.ts").scanSync({ cwd: join(root, "src") })) {
    const file = join("src", rel);
    const parts = file.split(sep);
    if (parts.includes("node_modules") || file.endsWith(".d.ts")) continue;
    // The platform app UIs are browser packages: they read responses, never write them.
    if (parts[1] === "platform" && parts[3] === "ui") continue;
    violations.push(...findUntypedJson(file, readFileSync(join(root, file), "utf-8")));
  }
  return violations;
}

if (import.meta.main) {
  const violations = scan(process.argv[2] ?? ROOT);
  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} JSON response(s) without a named type:\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    console.error(
      "\nDeclare the body in src/api/schemas/responses.ts and send it with json<ThatType>(body) from src/api/types.ts. See CODE_STYLE.md.",
    );
    process.exit(1);
  }
  console.log("✓ Every JSON response is a named response type");
}
