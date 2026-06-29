/**
 * Self-tests for `scripts/check-automation-paths.ts`.
 *
 * The lint exports its AST predicates so we can exercise them directly — no
 * subprocess, no fixture-on-disk dance. Each predicate is tested against a small
 * parsed snippet that either matches (a forbidden identity-owned construction)
 * or doesn't (the sanctioned workspace-owned shape). Same shape as
 * `check-file-paths.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import {
  isIdentityAutomationsDataPath,
  isUsersScopedAutomationsJoin,
} from "../../../scripts/check-automation-paths.ts";

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

const isGetDataPathCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  n.expression.name.text === "getDataPath";

describe("check-automation-paths — isIdentityAutomationsDataPath", () => {
  test("matches `getIdentityContext(owner).getDataPath('automations')`", () => {
    const src = parse(`const dir = getIdentityContext(owner).getDataPath("automations");`);
    const call = findFirst(src, isGetDataPathCall);
    expect(call).toBeDefined();
    expect(isIdentityAutomationsDataPath(call!)).toBe(true);
  });

  test("matches `runtime.getIdentityContext(owner).getDataPath('automations', id)`", () => {
    const src = parse(`const p = runtime.getIdentityContext(owner).getDataPath("automations", id);`);
    const call = findFirst(src, isGetDataPathCall);
    expect(isIdentityAutomationsDataPath(call!)).toBe(true);
  });

  test("matches `new IdentityContext({...}).getDataPath('automations')`", () => {
    const src = parse(`const p = new IdentityContext({ userId, workDir }).getDataPath("automations");`);
    const call = findFirst(src, isGetDataPathCall);
    expect(isIdentityAutomationsDataPath(call!)).toBe(true);
  });

  test("does NOT match `getIdentityContext(owner).getDataPath('files')` (different subdir)", () => {
    const src = parse(`const dir = getIdentityContext(owner).getDataPath("files");`);
    const call = findFirst(src, isGetDataPathCall);
    expect(isIdentityAutomationsDataPath(call!)).toBe(false);
  });

  test("does NOT match `ctx.getDataPath('automations')` where the receiver is unrelated", () => {
    const src = parse(`const dir = ctx.getDataPath("automations");`);
    const call = findFirst(src, isGetDataPathCall);
    expect(isIdentityAutomationsDataPath(call!)).toBe(false);
  });

  test("does NOT match the sanctioned `workspaceAutomationsDir(workDir, wsId, ownerId)`", () => {
    const src = parse(`const dir = workspaceAutomationsDir(workDir, wsId, ownerId);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isIdentityAutomationsDataPath(call!)).toBe(false);
  });
});

describe("check-automation-paths — isUsersScopedAutomationsJoin", () => {
  test("matches `join(workDir, 'users', ownerId, 'automations')`", () => {
    const src = parse(`const dir = join(workDir, "users", ownerId, "automations");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(call).toBeDefined();
    expect(isUsersScopedAutomationsJoin(call!)).toBe(true);
  });

  test("does NOT match a workspace-scoped join (no 'users' literal)", () => {
    const src = parse(`const dir = join(workDir, "workspaces", wsId, "automations", ownerId);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isUsersScopedAutomationsJoin(call!)).toBe(false);
  });

  test("does NOT match a users join that isn't for automations", () => {
    const src = parse(`const dir = join(workDir, "users", ownerId, "files");`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isUsersScopedAutomationsJoin(call!)).toBe(false);
  });

  test("does NOT match the sanctioned `workspaceAutomationsDir(...)`", () => {
    const src = parse(`const dir = workspaceAutomationsDir(workDir, wsId, ownerId);`);
    const call = findFirst(src, ts.isCallExpression);
    expect(isUsersScopedAutomationsJoin(call!)).toBe(false);
  });
});

describe("check-automation-paths — script self-invocation", () => {
  test("runs end-to-end against src/ and speaks the workspace-owned contract", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/check-automation-paths.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      expect(stdout).toContain("No identity-owned automations paths");
    } else {
      expect(stderr).toContain("workspaceAutomationsDir");
    }
  });
});
