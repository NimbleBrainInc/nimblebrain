/**
 * Self-tests for `scripts/check-conversation-paths.ts`.
 *
 * The lint exports its AST predicates so we can exercise them
 * directly — no subprocess, no fixture-on-disk dance. Each predicate
 * is tested against a small parsed snippet that either matches or
 * doesn't, and against a clean snippet that must not match.
 */

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  isWorkspaceConversationJoin,
  isWorkspaceConversationStringLiteral,
  isWorkspaceConversationTemplate,
} from "../../../scripts/check-conversation-paths.ts";

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

describe("check-conversation-paths — isWorkspaceConversationJoin", () => {
  test("matches `join(workDir, 'workspaces', wsId, 'conversations', file)`", () => {
    const src = parse(
      `const path = join(workDir, "workspaces", wsId, "conversations", file);`,
    );
    const call = findFirst(src, ts.isCallExpression);
    expect(call).toBeDefined();
    expect(isWorkspaceConversationJoin(call!)).toBe(true);
  });

  test("does NOT match `join(workDir, 'workspaces')` (parent dir; legitimate)", () => {
    const src = parse(`const dir = join(workDir, "workspaces");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isWorkspaceConversationJoin(call!)).toBe(false);
  });

  test("does NOT match `join(workDir, 'conversations')` (top-level path; the intended form)", () => {
    const src = parse(`const dir = join(workDir, "conversations");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isWorkspaceConversationJoin(call!)).toBe(false);
  });

  test("does NOT match `join(workDir, 'workspaces', wsId, 'files')` (different subdir)", () => {
    const src = parse(`const dir = join(workDir, "workspaces", wsId, "files");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isWorkspaceConversationJoin(call!)).toBe(false);
  });

  test("matches `path.join(...)` too — accepts any callee named 'join'", () => {
    const src = parse(`const p = path.join(root, "workspaces", id, "conversations");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isWorkspaceConversationJoin(call!)).toBe(true);
  });
});

describe("check-conversation-paths — isWorkspaceConversationTemplate", () => {
  test("matches a template literal that spells out the workspace-conv path", () => {
    const src = parse("const p = `${workDir}/workspaces/${wsId}/conversations/${id}.jsonl`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(node).toBeDefined();
    expect(isWorkspaceConversationTemplate(node!)).toBe(true);
  });

  test("does NOT match a template that ends at /workspaces/${wsId}", () => {
    const src = parse("const p = `${workDir}/workspaces/${wsId}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isWorkspaceConversationTemplate(node!)).toBe(false);
  });

  test("does NOT match a template that uses /conversations/ at top-level", () => {
    const src = parse("const p = `${workDir}/conversations/${id}.jsonl`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isWorkspaceConversationTemplate(node!)).toBe(false);
  });
});

describe("check-conversation-paths — isWorkspaceConversationStringLiteral", () => {
  test("matches a string literal containing the substring path", () => {
    const src = parse(`const p = "/work/workspaces/ws_a/conversations/foo.jsonl";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isWorkspaceConversationStringLiteral(node!)).toBe(true);
  });

  test("does NOT match a string with /conversations/ but no /workspaces/", () => {
    const src = parse(`const p = "/work/conversations/foo.jsonl";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isWorkspaceConversationStringLiteral(node!)).toBe(false);
  });
});

describe("check-conversation-paths — script self-invocation", () => {
  test("clean tree: running the script produces a passing message and exits 0", async () => {
    // Subprocess invocation: the lint runs against the current src/
    // tree, which is the post-Stage-1 clean state. Exit 0 here proves
    // the predicate set above doesn't false-positive on the actual
    // codebase. The matching "exit 1 on violation" half is covered by
    // the predicate unit tests above — each is a single fixture
    // snippet that the predicate either flags or doesn't.
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/check-conversation-paths.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
