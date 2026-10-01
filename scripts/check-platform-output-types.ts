#!/usr/bin/env bun
/**
 * Lint: a platform tool handler returns a named output type, never `object`.
 *
 * A handler's return type is its tool's contract (`src/platform/AGENTS.md`
 * §2.1). Declared as `object` or `Promise<object>`, the result reaches every
 * caller untyped, so each one re-declares the shape inline and drifts from the
 * handler the first time it changes. A named `XxxOutput` from
 * `src/platform/schemas/` makes that drift a compile error.
 *
 * What this script flags: a function implementation (declaration, method,
 * arrow function, or function expression) in a `.ts` file under
 * `src/platform/`, outside the app UI packages (`src/platform/<app>/ui/`),
 * whose declared return type is `object`, or `Promise<object>`, or a union
 * with either as a member. A function TYPE is not flagged: the registration
 * signatures that accept a handler (`fn: (input) => Promise<object>`) bound
 * what they take, and the handler passed in carries its own return type.
 * Rule and examples: CODE_STYLE.md, "Platform tool handlers return a named
 * output type".
 */

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");

const PLATFORM_DIR = join("src", "platform");

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

/** True when `type` is `object`, `Promise<object>`, or a union holding either. */
export function isBareObjectReturn(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.ObjectKeyword) return true;
  if (ts.isParenthesizedTypeNode(type)) return isBareObjectReturn(type.type);
  if (ts.isUnionTypeNode(type)) return type.types.some(isBareObjectReturn);
  if (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "Promise" &&
    type.typeArguments?.length === 1
  ) {
    return isBareObjectReturn(type.typeArguments[0]!);
  }
  return false;
}

type FunctionImplementation =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

function isFunctionImplementation(node: ts.Node): node is FunctionImplementation {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

/** Every function implementation in one file whose declared return type is `object`. */
export function findObjectReturns(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const violations: Violation[] = [];
  function visit(node: ts.Node): void {
    if (isFunctionImplementation(node) && node.type && isBareObjectReturn(node.type)) {
      const { line } = source.getLineAndCharacterOfPosition(node.type.getStart(source));
      violations.push({ file, line: line + 1, snippet: (lines[line] ?? "").trim() });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

/** Scan `<root>/src/platform`, skipping app UI packages. Paths in the result are relative to `root`. */
export function scan(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const rel of new Glob("**/*.ts").scanSync({ cwd: join(root, PLATFORM_DIR) })) {
    const segments = rel.split(sep);
    if (segments.includes("node_modules") || segments[1] === "ui" || rel.endsWith(".d.ts")) {
      continue;
    }
    const file = join(PLATFORM_DIR, rel);
    violations.push(...findObjectReturns(file, readFileSync(join(root, file), "utf-8")));
  }
  return violations;
}

if (import.meta.main) {
  const violations = scan(process.argv[2] ?? ROOT);
  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} platform function(s) returning \`object\`:\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    console.error(
      "\nDeclare a named XxxOutput in src/platform/schemas/<app>.ts and make it the handler's return type. See src/platform/AGENTS.md §2.1 and CODE_STYLE.md.",
    );
    process.exit(1);
  }
  console.log("✓ No platform function returns `object`");
}
