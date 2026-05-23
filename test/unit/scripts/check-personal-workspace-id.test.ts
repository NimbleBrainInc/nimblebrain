/**
 * Self-tests for `scripts/check-personal-workspace-id.ts`.
 */

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  isPrefixConcat,
  isPrefixInBinaryPlus,
  isPrefixLiteral,
  isPrefixTemplate,
} from "../../../scripts/check-personal-workspace-id.ts";

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

describe("check-personal-workspace-id — isPrefixLiteral", () => {
  test("matches the exact prefix string", () => {
    const src = parse(`const s = "ws_user_";`);
    const lit = findFirst(src, ts.isStringLiteral);
    expect(isPrefixLiteral(lit!)).toBe(true);
  });

  test("does NOT match an unrelated literal", () => {
    const src = parse(`const s = "ws_other_";`);
    const lit = findFirst(src, ts.isStringLiteral);
    expect(isPrefixLiteral(lit!)).toBe(false);
  });
});

describe("check-personal-workspace-id — isPrefixInBinaryPlus", () => {
  test("matches `'ws_user_' + userId`", () => {
    const src = parse(`const id = "ws_user_" + userId;`);
    const bin = findFirst(src, ts.isBinaryExpression);
    expect(isPrefixInBinaryPlus(bin!)).toBe(true);
  });

  test("matches `'ws_user_' + a + b` (chained)", () => {
    const src = parse(`const id = "ws_user_" + a + b;`);
    const bin = findFirst(src, ts.isBinaryExpression);
    expect(isPrefixInBinaryPlus(bin!)).toBe(true);
  });

  test("does NOT match unrelated concat", () => {
    const src = parse(`const id = "ws_" + userId;`);
    const bin = findFirst(src, ts.isBinaryExpression);
    expect(isPrefixInBinaryPlus(bin!)).toBe(false);
  });
});

describe("check-personal-workspace-id — isPrefixConcat", () => {
  test("matches `'ws_user_'.concat(userId)`", () => {
    const src = parse(`const id = "ws_user_".concat(userId);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isPrefixConcat(call!)).toBe(true);
  });

  test("does NOT match a generic .concat call", () => {
    const src = parse(`const xs = arr.concat(more);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isPrefixConcat(call!)).toBe(false);
  });
});

describe("check-personal-workspace-id — isPrefixTemplate", () => {
  test("matches `` `ws_user_${userId}` ``", () => {
    const src = parse("const id = `ws_user_${userId}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(node).toBeDefined();
    expect(isPrefixTemplate(node!)).toBe(true);
  });

  test("matches `` `ws_user_${userId}/foo` ``", () => {
    const src = parse("const p = `ws_user_${userId}/foo`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isPrefixTemplate(node!)).toBe(true);
  });

  test("does NOT match a template that starts with a different prefix", () => {
    const src = parse("const id = `ws_other_${userId}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isPrefixTemplate(node!)).toBe(false);
  });
});

describe("check-personal-workspace-id — script self-invocation", () => {
  test("clean tree: running the script produces a passing message and exits 0", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/check-personal-workspace-id.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
