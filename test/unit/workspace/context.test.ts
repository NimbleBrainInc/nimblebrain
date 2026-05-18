import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  WorkspaceCredentialStore,
  getWorkspaceCredentials,
  saveWorkspaceCredential,
} from "../../../src/config/workspace-credentials.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

const WS_A = "ws_alpha";
const WS_B = "ws_beta";
const BUNDLE = "@nimblebraininc/newsapi";

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
    expect(ctx.getRoot()).toBe("/tmp/nb/workspaces/ws_alpha");
  });

  test("getDataPath('root') is identical to getRoot()", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("root")).toBe(ctx.getRoot());
  });

  test("getDataPath(scope) builds workspaces/{wsId}/{scope}", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("conversations")).toBe(
      "/tmp/nb/workspaces/ws_alpha/conversations",
    );
    expect(ctx.getDataPath("data")).toBe("/tmp/nb/workspaces/ws_alpha/data");
    expect(ctx.getDataPath("skills")).toBe("/tmp/nb/workspaces/ws_alpha/skills");
    expect(ctx.getDataPath("files")).toBe("/tmp/nb/workspaces/ws_alpha/files");
    expect(ctx.getDataPath("credentials")).toBe(
      "/tmp/nb/workspaces/ws_alpha/credentials",
    );
  });

  test("getDataPath accepts safe subpath segments", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("credentials", "mcp-oauth", "google")).toBe(
      "/tmp/nb/workspaces/ws_alpha/credentials/mcp-oauth/google",
    );
    expect(ctx.getDataPath("credentials", "secrets")).toBe(
      "/tmp/nb/workspaces/ws_alpha/credentials/secrets",
    );
    expect(ctx.getDataPath("data", "@scope-bundle-slug")).toBe(
      "/tmp/nb/workspaces/ws_alpha/data/@scope-bundle-slug",
    );
  });

  test("getDataPath('root', subpath) builds under the workspace root", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(ctx.getDataPath("root", "workspace.json")).toBe(
      "/tmp/nb/workspaces/ws_alpha/workspace.json",
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
    expect(() => ctx.getDataPath("credentials", "mcp-oauth/../escape")).toThrow(
      /traversal/,
    );
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

  test("getCredentialStore is bound to the context's wsId", () => {
    const a = new WorkspaceContext({ wsId: WS_A, workDir });
    const b = new WorkspaceContext({ wsId: WS_B, workDir });
    expect(a.getCredentialStore().workspaceId).toBe(WS_A);
    expect(b.getCredentialStore().workspaceId).toBe(WS_B);
  });

  test("the credential store returned is the same instance across calls (memoized)", () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(ctx.getCredentialStore()).toBe(ctx.getCredentialStore());
  });

  test("credentials written via context A are not visible via context B", async () => {
    const a = new WorkspaceContext({ wsId: WS_A, workDir });
    const b = new WorkspaceContext({ wsId: WS_B, workDir });
    await a.getCredentialStore().save(BUNDLE, "api_key", "sk-alpha");
    expect(await b.getCredentials(BUNDLE)).toBeNull();
    expect(await a.getCredentials(BUNDLE)).toEqual({ api_key: "sk-alpha" });
  });
});

// ── WorkspaceContext.getCredentials behaviour parity ──────────────

describe("WorkspaceContext.getCredentials", () => {
  test("returns null when no credentials are saved", async () => {
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(await ctx.getCredentials(BUNDLE)).toBeNull();
  });

  test("returns the same map as the free-function shim for the same input", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-equal", workDir);
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    expect(await ctx.getCredentials(BUNDLE)).toEqual(
      (await getWorkspaceCredentials(WS_A, BUNDLE, workDir)) ?? {},
    );
  });
});

// ── WorkspaceCredentialStore class-direct ─────────────────────────

describe("WorkspaceCredentialStore (direct)", () => {
  test("save then get roundtrip", async () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir });
    await store.save(BUNDLE, "api_key", "sk-store");
    expect(await store.get(BUNDLE)).toEqual({ api_key: "sk-store" });
  });

  test("save merges with existing keys (does not overwrite the whole map)", async () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir });
    await store.save(BUNDLE, "api_key", "sk-store");
    await store.save(BUNDLE, "workspace_id", "ws-extra");
    expect(await store.get(BUNDLE)).toEqual({
      api_key: "sk-store",
      workspace_id: "ws-extra",
    });
  });

  test("clear removes a single key and reports whether it existed", async () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir });
    await store.save(BUNDLE, "api_key", "sk-store");
    await store.save(BUNDLE, "workspace_id", "ws-extra");
    expect(await store.clear(BUNDLE, "api_key")).toBe(true);
    expect(await store.clear(BUNDLE, "api_key")).toBe(false);
    expect(await store.get(BUNDLE)).toEqual({ workspace_id: "ws-extra" });
  });

  test("clearAll removes the credential file entirely", async () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir });
    await store.save(BUNDLE, "api_key", "sk-store");
    expect(await store.clearAll(BUNDLE)).toBe(true);
    expect(await store.get(BUNDLE)).toBeNull();
    expect(await store.clearAll(BUNDLE)).toBe(false);
  });

  test("rejects an invalid wsId at construction", () => {
    expect(() => new WorkspaceCredentialStore({ wsId: "bogus", workDir })).toThrow(
      /invalid wsId/,
    );
  });

  test("credentialPath builds under workspaces/{wsId}/credentials/", () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir: "/tmp/nb" });
    expect(store.credentialPath(BUNDLE)).toBe(
      "/tmp/nb/workspaces/ws_alpha/credentials/nimblebraininc-newsapi.json",
    );
  });

  test("writes the credential file with mode 0o600", async () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir });
    await store.save(BUNDLE, "api_key", "sk-mode");
    const path = store.credentialPath(BUNDLE);
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
    // Sanity: confirm the file is actually on disk where we think it is.
    expect((await readFile(path, "utf-8")).length).toBeGreaterThan(0);
  });

  test("resolveUserConfig returns stored values matching the schema fields", async () => {
    const store = new WorkspaceCredentialStore({ wsId: WS_A, workDir });
    await store.save(BUNDLE, "api_key", "sk-resolved");
    const resolved = await store.resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: {
        api_key: { type: "string", title: "API key", required: true },
        unset: { type: "string", required: false },
      },
    });
    expect(resolved).toEqual({ api_key: "sk-resolved" });
  });
});

// ── Shim parity: free function output == class output ─────────────

describe("free-function shim parity", () => {
  test("getWorkspaceCredentials and ctx.getCredentials return identical results", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-parity", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "workspace_id", "ws-parity", workDir);
    const viaShim = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    const viaContext = await new WorkspaceContext({ wsId: WS_A, workDir }).getCredentials(BUNDLE);
    expect(viaShim).toEqual(viaContext);
  });
});

// ── Stage 0 isolation invariants ──────────────────────────────────
//
// These are the structural tests REFACTOR_PLAN Stage 0 commits to:
// "WorkspaceContext(A) cannot produce credentials or paths for
//  workspace B." Each test exercises a different surface of the
// context (paths, credential store binding, on-disk visibility) and
// proves the boundary holds. Failure of any test here means a
// regression in workspace isolation, not a trivial implementation
// detail — these are the load-bearing invariants for the whole
// delegation-model refactor.

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

  test("getDataPath has no signature that accepts a foreign wsId", () => {
    // Structural / type-level guarantee — TypeScript's strict mode
    // rejects an attempt to pass an extra wsId here at compile time.
    // The runtime assertion below confirms the public surface area
    // matches the design: the only inputs to getDataPath are a scope
    // literal and subpath strings.
    const ctx = new WorkspaceContext({ wsId: WS_A, workDir });
    // @ts-expect-error — passing a wsId-shaped argument as a "subpath"
    // is allowed by the variadic string signature but ROUTED through
    // the subpath validator. The validator rejects path traversal, so
    // an attempt like `ctx.getDataPath("credentials", "../ws_beta")`
    // throws rather than escaping.
    expect(() => ctx.getDataPath("credentials", "../ws_beta")).toThrow(/traversal/);
  });

  test("credential store from context A cannot mutate workspace B's file", async () => {
    const a = new WorkspaceContext({ wsId: WS_A, workDir });
    const b = new WorkspaceContext({ wsId: WS_B, workDir });
    const storeA = a.getCredentialStore();
    const storeB = b.getCredentialStore();
    // Same bundle name, same key, different value — written via A.
    await storeA.save(BUNDLE, "api_key", "sk-from-A");
    // Reading via B sees nothing (or only its own values, which are absent).
    expect(await storeB.get(BUNDLE)).toBeNull();
    // Save via B sets B's own value without touching A's.
    await storeB.save(BUNDLE, "api_key", "sk-from-B");
    expect(await storeA.get(BUNDLE)).toEqual({ api_key: "sk-from-A" });
    expect(await storeB.get(BUNDLE)).toEqual({ api_key: "sk-from-B" });
    // Clearing B doesn't clear A.
    await storeB.clearAll(BUNDLE);
    expect(await storeA.get(BUNDLE)).toEqual({ api_key: "sk-from-A" });
    expect(await storeB.get(BUNDLE)).toBeNull();
  });

  test("credential store path derivation is bound by construction, not per-call", () => {
    // Concrete check that the store's `credentialPath` is parameter-free
    // with respect to the workspace — only the bundle name varies.
    // Two stores for different workspaces produce non-overlapping paths
    // even for an identically-named bundle.
    const storeA = new WorkspaceContext({ wsId: WS_A, workDir }).getCredentialStore();
    const storeB = new WorkspaceContext({ wsId: WS_B, workDir }).getCredentialStore();
    expect(storeA.credentialPath(BUNDLE)).not.toBe(storeB.credentialPath(BUNDLE));
    expect(storeA.credentialPath(BUNDLE).includes(`/${WS_A}/`)).toBe(true);
    expect(storeB.credentialPath(BUNDLE).includes(`/${WS_B}/`)).toBe(true);
    expect(storeA.credentialPath(BUNDLE).includes(`/${WS_B}/`)).toBe(false);
    expect(storeB.credentialPath(BUNDLE).includes(`/${WS_A}/`)).toBe(false);
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
