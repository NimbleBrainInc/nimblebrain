import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

const WS_A = "ws_00164434d8dd7ffb";
const WS_B = "ws_002038aa71ea4b8a";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-context-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Constructor validation ────────────────────────────────────────

describe("WorkspaceContext constructor", () => {
  test("accepts a valid wsId", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(ctx.workspaceId).toBe(WS_A);
    expect(ctx.workDir).toBe(workDir);
  });

  test("rejects an empty wsId", () => {
    expect(() => new WorkspaceContext({ wsId: "", workDir })).toThrow(/invalid wsId/);
  });

  test("rejects a wsId without the ws_ prefix", () => {
    expect(() => new WorkspaceContext({ wsId: "alpha", workDir })).toThrow(/invalid wsId/);
  });

  test("rejects a wsId that would traverse the filesystem", () => {
    // `..` doesn't match the regex; the validator must reject it.
    expect(() => new WorkspaceContext({ wsId: "../evil", workDir })).toThrow(/invalid wsId/);
    expect(() => new WorkspaceContext({ wsId: "ws_../evil", workDir })).toThrow(/invalid wsId/);
  });

  test("rejects an empty workDir", () => {
    expect(() => new WorkspaceContext({ wsId: WS_A, workDir: "" })).toThrow(/workDir is required/);
  });
});

// ── Path helpers ──────────────────────────────────────────────────

describe("WorkspaceContext.getRoot / getDataPath", () => {
  test("getRoot returns workspaces/{wsId} under workDir", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getRoot()).toBe("/tmp/nb/workspaces/ws_00164434d8dd7ffb");
  });

  test("getDataPath('root') is identical to getRoot()", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("root")).toBe(ctx.getRoot());
  });

  test("getDataPath(scope) builds workspaces/{wsId}/{scope}", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("conversations")).toBe(
      "/tmp/nb/workspaces/ws_00164434d8dd7ffb/conversations",
    );
    expect(ctx.getDataPath("data")).toBe("/tmp/nb/workspaces/ws_00164434d8dd7ffb/data");
    expect(ctx.getDataPath("skills")).toBe("/tmp/nb/workspaces/ws_00164434d8dd7ffb/skills");
    expect(ctx.getDataPath("files")).toBe("/tmp/nb/workspaces/ws_00164434d8dd7ffb/files");
    expect(ctx.getDataPath("credentials")).toBe(
      "/tmp/nb/workspaces/ws_00164434d8dd7ffb/credentials",
    );
  });

  test("getDataPath accepts safe subpath segments", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("credentials", "mcp-oauth", "google")).toBe(
      "/tmp/nb/workspaces/ws_00164434d8dd7ffb/credentials/mcp-oauth/google",
    );
    expect(ctx.getDataPath("credentials", "secrets")).toBe(
      "/tmp/nb/workspaces/ws_00164434d8dd7ffb/credentials/secrets",
    );
    expect(ctx.getDataPath("data", "@scope-connector-slug")).toBe(
      "/tmp/nb/workspaces/ws_00164434d8dd7ffb/data/@scope-connector-slug",
    );
  });

  test("getDataPath('root', subpath) builds under the workspace root", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("root", "workspace.json")).toBe(
      "/tmp/nb/workspaces/ws_00164434d8dd7ffb/workspace.json",
    );
  });

  test("getDataPath rejects '..' traversal", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("credentials", "..")).toThrow(/path traversal|traversal/);
    expect(() => ctx.getDataPath("data", "..", "evil")).toThrow(/path traversal|traversal/);
  });

  test("getDataPath rejects null bytes", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("credentials", "evil\0")).toThrow(/null byte/);
  });

  test("getDataPath rejects absolute-looking subpaths", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("data", "/etc/passwd")).toThrow(/absolute subpath/);
  });

  test("getDataPath rejects backslashes", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("data", "evil\\path")).toThrow(/backslash/);
  });

  test("getDataPath rejects '..' embedded inside a slash-joined segment", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("credentials", "mcp-oauth/../escape")).toThrow(/traversal/);
  });

  test("getDataPath rejects empty segments", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("data", "")).toThrow(/empty subpath/);
  });
});

// ── Isolation: two contexts cannot cross ──────────────────────────

describe("WorkspaceContext isolation", () => {
  test("contexts for different workspaces yield different paths for the same scope", () => {
    const a = new WorkspaceContext({ wsId: WS_A, workDir });
    const b = new WorkspaceContext({ wsId: WS_B, workDir });
    expect(a.getDataPath("credentials")).not.toBe(b.getDataPath("credentials"));
    expect(a.getRoot()).not.toBe(b.getRoot());
  });
});

// ── Isolation invariants ──────────────────────────────────────────
//
// The structural guarantee: "WorkspaceContext(A) cannot produce paths
// for workspace B." Each
// test exercises a different surface of the context and proves the
// boundary holds. Failure of any test here means a
// regression in workspace isolation, not a trivial implementation
// detail — these are the load-bearing invariants for cross-workspace
// isolation.

describe("Stage 0 isolation invariants", () => {
  test("every scope path under context A is disjoint from context B", () => {
    const a = new WorkspaceContext({ wsId: WS_A, workDir });
    const b = new WorkspaceContext({ wsId: WS_B, workDir });
    const scopes = ["root", "data", "credentials", "conversations", "skills", "files"] as const;
    for (const scope of scopes) {
      const pa = a.getDataPath(scope);
      const pb = b.getDataPath(scope);
      expect(pa).not.toBe(pb);
      expect(pa.startsWith(`${b.getRoot()}/`) || pa === b.getRoot()).toBe(false);
      expect(pb.startsWith(`${a.getRoot()}/`) || pb === a.getRoot()).toBe(false);
    }
  });

  test("getDataPath rejects a foreign-wsId-shaped subpath via the traversal guard", () => {
    // The most plausible bypass attempt at runtime is smuggling a
    // foreign wsId into a `getDataPath` call as a subpath segment
    // (`ctx.getDataPath("credentials", "../ws_002038aa71ea4b8a")`). The variadic
    // string signature would let that compile, so the subpath
    // validator is the load-bearing defense — it rejects `..`
    // components before they reach the filesystem.
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(() => ctx.getDataPath("credentials", "../ws_002038aa71ea4b8a")).toThrow(/traversal/);
  });

  test("workspaceId getter is read-only — no rebinding through the public surface", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(ctx.workspaceId).toBe(WS_A);
    // Assigning to a getter without a setter is silently ignored in
    // non-strict mode and throws in strict mode (bun runs strict-mode
    // ESM). Either way, the post-assignment value must still be WS_A.
    try {
      // @ts-expect-error — readonly by design; this assignment is the test.
      ctx.workspaceId = WS_B;
    } catch {
      // Strict-mode throw is acceptable — the invariant is the post-state.
    }
    expect(ctx.workspaceId).toBe(WS_A);
  });
});
