/**
 * Self-tests for `scripts/check-file-paths.ts`.
 *
 * The lint exports its AST predicates so we can exercise them directly — no
 * subprocess, no fixture-on-disk dance. Each predicate is tested against a small
 * parsed snippet that either matches (a forbidden construction) or doesn't (the
 * sanctioned room-owned shape). Same shape as `check-conversation-paths.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  isCreateFileStoreCall,
  isIdentityFilesDataPath,
} from "../../../scripts/check-file-paths.ts";

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

describe("check-file-paths — isCreateFileStoreCall", () => {
  test("matches `createFileStore(dir)`", () => {
    const src = parse(`const store = createFileStore(dir);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(call).toBeDefined();
    expect(isCreateFileStoreCall(call!)).toBe(true);
  });

  test("matches `createFileStore(roomFilesDir(workDir, wsId, ownerId))` (the sanctioned shape — allowed only by file)", () => {
    // The predicate flags every call; runtime.ts is exempted by the allow-list,
    // not by the predicate. Here we only assert the predicate fires.
    const src = parse(`const s = createFileStore(roomFilesDir(workDir, wsId, ownerId));`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isCreateFileStoreCall(call!)).toBe(true);
  });

  test("does NOT match an unrelated call `roomFilesDir(workDir, wsId, ownerId)`", () => {
    const src = parse(`const dir = roomFilesDir(workDir, wsId, ownerId);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isCreateFileStoreCall(call!)).toBe(false);
  });
});

describe("check-file-paths — isIdentityFilesDataPath", () => {
  test("matches `getIdentityContext(owner).getDataPath('files')`", () => {
    const src = parse(`const dir = getIdentityContext(owner).getDataPath("files");`);
    const call = findFirst(
      src,
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "getDataPath",
    );
    expect(call).toBeDefined();
    expect(isIdentityFilesDataPath(call!)).toBe(true);
  });

  test("matches `runtime.getIdentityContext(owner).getDataPath('files', id)`", () => {
    const src = parse(`const p = runtime.getIdentityContext(owner).getDataPath("files", id);`);
    const call = findFirst(
      src,
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "getDataPath",
    );
    expect(isIdentityFilesDataPath(call!)).toBe(true);
  });

  test("matches `new IdentityContext({...}).getDataPath('files')`", () => {
    const src = parse(
      `const p = new IdentityContext({ userId, workDir }).getDataPath("files");`,
    );
    const call = findFirst(
      src,
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "getDataPath",
    );
    expect(isIdentityFilesDataPath(call!)).toBe(true);
  });

  test("does NOT match `getIdentityContext(owner).getDataPath('automations')` (different subdir)", () => {
    const src = parse(`const dir = getIdentityContext(owner).getDataPath("automations");`);
    const call = findFirst(
      src,
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "getDataPath",
    );
    expect(isIdentityFilesDataPath(call!)).toBe(false);
  });

  test("does NOT match `ctx.getDataPath('files')` where the receiver is an unrelated variable", () => {
    const src = parse(`const dir = ctx.getDataPath("files");`);
    const call = findFirst(
      src,
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "getDataPath",
    );
    expect(isIdentityFilesDataPath(call!)).toBe(false);
  });

  test("does NOT match the sanctioned `roomFilesDir(workDir, wsId, ownerId)`", () => {
    const src = parse(`const dir = roomFilesDir(workDir, wsId, ownerId);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isIdentityFilesDataPath(call!)).toBe(false);
  });
});

describe("check-file-paths — script self-invocation", () => {
  test("runs end-to-end against src/ and speaks the room-owned contract", async () => {
    // The room-storage migration is in flight: src/ may still contain legacy
    // identity-owned file paths (the runtime is being de-identity-ed
    // concurrently), so the script may legitimately exit 0 (clean) or 1
    // (legacy paths still present). Either way it must run to completion and
    // emit the room-owned guidance. The exhaustive contract is covered by the
    // predicate unit tests above.
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/check-file-paths.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      expect(stdout).toContain("No identity-owned file paths");
    } else {
      expect(stderr).toContain("roomFilesDir");
    }
  });
});
