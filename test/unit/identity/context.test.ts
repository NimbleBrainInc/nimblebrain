/**
 * Unit tests for `src/identity/context.ts`.
 *
 * IdentityContext is the identity counterpart to WorkspaceContext: a typed
 * access path to per-user data at `{workDir}/users/{userId}/...`. Pins the
 * path layout + the traversal defenses (a userId or subpath that escapes
 * the `users/` tree must throw at construction / path-build, not later).
 */

import { describe, expect, test } from "bun:test";
import { IdentityContext } from "../../../src/identity/context.ts";

const WORK_DIR = "/tmp/nb-test";

describe("IdentityContext — construction", () => {
  test("binds userId + workDir and exposes the user root", () => {
    const ctx = new IdentityContext({ userId: "usr_abc123", workDir: WORK_DIR });
    expect(ctx.userId).toBe("usr_abc123");
    expect(ctx.workDir).toBe(WORK_DIR);
    expect(ctx.getRoot()).toBe("/tmp/nb-test/users/usr_abc123");
  });

  test("throws on empty userId", () => {
    expect(() => new IdentityContext({ userId: "", workDir: WORK_DIR })).toThrow();
  });

  test("throws on path-traversal userId — can't escape the users/ tree", () => {
    expect(() => new IdentityContext({ userId: "../etc", workDir: WORK_DIR })).toThrow();
    expect(() => new IdentityContext({ userId: "a/b", workDir: WORK_DIR })).toThrow();
  });

  test("throws on missing workDir", () => {
    expect(() => new IdentityContext({ userId: "usr_abc", workDir: "" })).toThrow();
  });
});

describe("IdentityContext — path helpers", () => {
  const ctx = new IdentityContext({ userId: "usr_abc", workDir: WORK_DIR });

  test("files scope", () => {
    expect(ctx.getDataPath("files")).toBe("/tmp/nb-test/users/usr_abc/files");
    expect(ctx.getDataPath("files", "file_1")).toBe("/tmp/nb-test/users/usr_abc/files/file_1");
  });

  test("skills scope", () => {
    expect(ctx.getDataPath("skills")).toBe("/tmp/nb-test/users/usr_abc/skills");
  });

  test("root scope returns the user root", () => {
    expect(ctx.getDataPath("root")).toBe("/tmp/nb-test/users/usr_abc");
  });

  test("rejects traversal in a subpath segment", () => {
    expect(() => ctx.getDataPath("files", "..")).toThrow();
    expect(() => ctx.getDataPath("files", "../../etc")).toThrow();
  });
});
