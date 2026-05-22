/**
 * Self-tests for `scripts/check-tool-namespace.ts`.
 *
 * The lint exports its AST predicates so each is exercised directly
 * against a small parsed snippet — same pattern as
 * `check-conversation-paths.test.ts` and
 * `check-personal-workspace-id.test.ts`. The script's own
 * self-invocation case at the bottom proves the clean src/ tree passes.
 */

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  isNamespacedSplit,
  isNamespacedToolBinaryConcat,
  isNamespacedToolStringLiteral,
  isNamespacedToolTemplate,
} from "../../../scripts/check-tool-namespace.ts";

function parse(snippet: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", snippet, ts.ScriptTarget.Latest, true);
}

function findFirst<T extends ts.Node>(
  src: ts.SourceFile,
  pred: (n: ts.Node) => n is T,
): T | undefined {
  let found: T | undefined;
  function visit(n: ts.Node): void {
    if (found) return;
    if (pred(n)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(src);
  return found;
}

describe("check-tool-namespace — isNamespacedToolStringLiteral", () => {
  test("matches a hard-coded `ws_helix/crm.search`", () => {
    const src = parse(`const s = "ws_helix/crm.search";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(node).toBeDefined();
    expect(isNamespacedToolStringLiteral(node!)).toBe(true);
  });

  test("does NOT match a plain workspace id literal `ws_helix`", () => {
    // The lint scope is the cross-workspace tool-name shape only.
    // Plain workspace ids are constructed by other helpers and have
    // their own (separate) lint.
    const src = parse(`const s = "ws_helix";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isNamespacedToolStringLiteral(node!)).toBe(false);
  });

  test("does NOT match an unrelated literal containing `/`", () => {
    const src = parse(`const s = "foo/bar";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isNamespacedToolStringLiteral(node!)).toBe(false);
  });
});

describe("check-tool-namespace — isNamespacedToolTemplate", () => {
  test("matches `` `ws_${wsId}/${name}` `` (head ends `ws_`, span ends `/`)", () => {
    const src = parse("const s = `ws_${wsId}/${name}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(node).toBeDefined();
    expect(isNamespacedToolTemplate(node!)).toBe(true);
  });

  test("matches `` `ws_helix/${name}` `` (literal id in head)", () => {
    const src = parse("const s = `ws_helix/${name}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isNamespacedToolTemplate(node!)).toBe(true);
  });

  test("does NOT match `` `ws_${wsId}` `` (no tool component)", () => {
    // `ws_${id}` builds a bare workspace id, not a tool name. Out of
    // scope for this lint.
    const src = parse("const s = `ws_${wsId}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isNamespacedToolTemplate(node!)).toBe(false);
  });

  test("does NOT match `` `prefix-ws_${wsId}/${name}` `` (head doesn't end with `ws_`)", () => {
    // Avoid false positives on unrelated templates whose head happens
    // to contain `ws_` mid-string.
    const src = parse("const s = `prefix-ws_${wsId}/${name}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isNamespacedToolTemplate(node!)).toBe(false);
  });
});

describe("check-tool-namespace — isNamespacedToolBinaryConcat", () => {
  test('matches `"ws_" + wsId + "/" + name`', () => {
    const src = parse('const s = "ws_" + wsId + "/" + name;');
    const bin = findFirst(src, ts.isBinaryExpression);
    expect(isNamespacedToolBinaryConcat(bin!)).toBe(true);
  });

  test('does NOT match `"ws_" + wsId` (no slash follow-up)', () => {
    const src = parse('const s = "ws_" + wsId;');
    const bin = findFirst(src, ts.isBinaryExpression);
    expect(isNamespacedToolBinaryConcat(bin!)).toBe(false);
  });

  test('does NOT match `"foo/" + name` (no ws_ prefix)', () => {
    const src = parse('const s = "foo/" + name;');
    const bin = findFirst(src, ts.isBinaryExpression);
    expect(isNamespacedToolBinaryConcat(bin!)).toBe(false);
  });
});

describe("check-tool-namespace — isNamespacedSplit", () => {
  test('matches `namespacedName.split("/")`', () => {
    const src = parse(`const [w, n] = namespacedName.split("/");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isNamespacedSplit(call!)).toBe(true);
  });

  test('matches `qualifiedToolName.split("/")`', () => {
    const src = parse(`const parts = qualifiedToolName.split("/");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isNamespacedSplit(call!)).toBe(true);
  });

  test('matches `toolName.split("/")`', () => {
    const src = parse(`const parts = toolName.split("/");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isNamespacedSplit(call!)).toBe(true);
  });

  test('does NOT match `urlPath.split("/")` (unrelated binding name)', () => {
    const src = parse(`const segments = urlPath.split("/");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isNamespacedSplit(call!)).toBe(false);
  });

  test('does NOT match `toolName.split(",")` (wrong separator)', () => {
    const src = parse(`const parts = toolName.split(",");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isNamespacedSplit(call!)).toBe(false);
  });

  test('does NOT match `obj.toolName.split("/")` (receiver is property access, not identifier)', () => {
    // Deliberate: the lint avoids false-positives by limiting to
    // direct identifier receivers. A real misuse will surface as
    // `const tn = obj.toolName; tn.split("/")` which IS flagged.
    const src = parse(`const parts = obj.toolName.split("/");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isNamespacedSplit(call!)).toBe(false);
  });
});

describe("check-tool-namespace — script self-invocation", () => {
  test("clean tree: running the script produces a passing message and exits 0", async () => {
    // Subprocess invocation: the lint runs against the current src/
    // tree, which after Task 002 lands in clean state. Exit 0 here
    // proves the predicate set above doesn't false-positive on the
    // actual codebase. The "exit 1 on violation" half is covered by
    // the predicate unit tests above.
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/check-tool-namespace.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
