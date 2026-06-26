/**
 * Self-tests for `scripts/check-conversation-paths.ts`.
 *
 * The lint exports its AST predicates so we can exercise them directly — no
 * subprocess, no fixture-on-disk dance. Each predicate is tested against a
 * small parsed snippet that either matches (a flat construction) or doesn't
 * (the room-owned shape, or an unrelated path). Same shape as
 * `check-credential-paths.test.ts` and `check-tool-namespace.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  isFlatConversationJoin,
  isFlatConversationStringLiteral,
  isFlatConversationTemplate,
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

describe("check-conversation-paths — isFlatConversationJoin", () => {
  test("matches `join(workDir, 'conversations')` (the forbidden flat path)", () => {
    const src = parse(`const dir = join(workDir, "conversations");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(call).toBeDefined();
    expect(isFlatConversationJoin(call!)).toBe(true);
  });

  test("matches `join(runtime.getWorkDir(), 'conversations', file)` (workDir accessor base)", () => {
    const src = parse(`const p = join(runtime.getWorkDir(), "conversations", file);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(true);
  });

  test("does NOT match `join(workDir, 'workspaces', wsId, 'conversations', file)` (room-owned)", () => {
    const src = parse(`const path = join(workDir, "workspaces", wsId, "conversations", file);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(false);
  });

  test("does NOT match `join(this.workspacesRoot, wsId, 'conversations')` (workspace-scoped base)", () => {
    const src = parse(`const convRoot = join(this.workspacesRoot, wsId, "conversations");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(false);
  });

  test("does NOT match `join(getWorkspaceScopedDir(), 'conversations')` (workspace-scoped base)", () => {
    const src = parse(`const dir = join(getWorkspaceScopedDir(), "conversations");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(false);
  });

  test("does NOT match `join(workDir, 'workspaces')` (parent dir; no conversations)", () => {
    const src = parse(`const dir = join(workDir, "workspaces");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(false);
  });

  test("does NOT match `join(workDir, 'cache')` (different top-level subdir)", () => {
    const src = parse(`const dir = join(workDir, "cache");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(false);
  });

  test("matches `path.join(...)` too — accepts any callee named 'join'", () => {
    const src = parse(`const p = path.join(root, "conversations", id);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isFlatConversationJoin(call!)).toBe(true);
  });
});

describe("check-conversation-paths — isFlatConversationTemplate", () => {
  test("matches a template literal that uses /conversations/ at top-level", () => {
    const src = parse("const p = `${workDir}/conversations/${id}.jsonl`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(node).toBeDefined();
    expect(isFlatConversationTemplate(node!)).toBe(true);
  });

  test("does NOT match a template that spells out the room-owned conversation path", () => {
    const src = parse(
      "const p = `${workDir}/workspaces/${wsId}/conversations/${ownerId}/${id}.jsonl`;",
    );
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isFlatConversationTemplate(node!)).toBe(false);
  });

  test("does NOT match a template that ends at /workspaces/${wsId} (no conversations segment)", () => {
    const src = parse("const p = `${workDir}/workspaces/${wsId}`;");
    const node = findFirst(src, ts.isTemplateExpression);
    expect(isFlatConversationTemplate(node!)).toBe(false);
  });
});

describe("check-conversation-paths — isFlatConversationStringLiteral", () => {
  test("matches a flat conversation file literal", () => {
    const src = parse(`const p = "/work/conversations/foo.jsonl";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isFlatConversationStringLiteral(node!)).toBe(true);
  });

  test("does NOT match the room-owned conversation file literal", () => {
    const src = parse(`const p = "/work/workspaces/ws_a/conversations/user_x/foo.jsonl";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isFlatConversationStringLiteral(node!)).toBe(false);
  });

  test("does NOT match a resource URI `ui://conversations/browser`", () => {
    const src = parse(`const u = "ui://conversations/browser";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isFlatConversationStringLiteral(node!)).toBe(false);
  });

  test("does NOT match a package route `@nimblebraininc/conversations`", () => {
    const src = parse(`const r = "@nimblebraininc/conversations";`);
    const node = findFirst(src, ts.isStringLiteral);
    expect(isFlatConversationStringLiteral(node!)).toBe(false);
  });
});

describe("check-conversation-paths — script self-invocation", () => {
  test("runs end-to-end against src/ and speaks the inverted contract", async () => {
    // The room-storage migration is in flight: src/ may still contain flat
    // conversation constructions (the runtime is being de-flatted
    // concurrently), so the script may legitimately exit 0 (clean) or 1
    // (flat paths still present). Either way it must run to completion and
    // emit the room-owned guidance. The exhaustive match/no-match contract
    // is covered by the predicate unit tests above.
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/check-conversation-paths.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      expect(stdout).toContain("No flat conversation paths");
    } else {
      expect(stderr).toContain("roomConversationsDir");
    }
  });
});
