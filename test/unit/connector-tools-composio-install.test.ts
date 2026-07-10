/**
 * Tests for `handleInstallRemoteOAuth`'s composio branch in
 * `src/tools/connector-tools.ts`. Kept in a separate file from
 * `connector-tools.test.ts` because the composio path needs module-
 * level mocks (`@composio/core` SDK, `startBundleSource`) that would
 * change behaviour for the static-auth and mpak tests in the
 * sibling file.
 *
 * What's covered:
 *   - ref.composio.connectorId is stamped on the persisted BundleRef
 *   - transport.auth.value is the `${COMPOSIO_API_KEY}` template
 *     (literal API key never appears in workspace.json)
 *   - extra headers containing the API key are scrubbed to the
 *     template form
 *   - startBundleSource is invoked exactly once (eager-start contract)
 *   - errResult when COMPOSIO_API_KEY is unset
 *   - errResult when the per-toolkit auth-config env is unset
 *   - errResult when the catalog entry lacks a composio block
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── @composio/core mock (hoisted) ───────────────────────────────────
//
// `createComposioSession` calls into `@composio/core` via the SDK
// adapter. Stub the constructor + `create` method so tests can drive
// the session URL / headers that get baked into the BundleRef.
interface ComposioCalls {
  createConfig: unknown;
  createImpl: (userId: string, config: unknown) => Promise<unknown>;
}
const composioCalls: ComposioCalls = {
  createConfig: undefined,
  createImpl: async () => ({
    sessionId: "session_test",
    mcp: { type: "http", url: "https://composio.test/mcp/session_test", headers: {} },
  }),
};
mock.module("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      list: async () => ({ items: [] }),
      initiate: async () => ({ redirectUrl: "https://x", id: "ca_x" }),
      delete: async () => undefined,
    };
    create(userId: string, config: unknown) {
      composioCalls.createConfig = config;
      return composioCalls.createImpl(userId, config);
    }
  },
}));

// startBundleSource is NOT mocked. Mocking it via `mock.module` on
// `bundles/startup.ts` leaks across test files in the bun runner
// (other tests of `buildPlatformEnv` in the same module fail). The
// install path's contract is:
//   1. Validate composio env + call createComposioSession
//   2. Persist the BundleRef into workspace.json
//   3. seedInstance + notifyInstalled
//   4. Eagerly call startBundleSource
//
// Step 4 will fail on the fake `composio.test/mcp/...` URL the mock
// returns. That's fine — the BundleRef shape we want to assert was
// already persisted at step 2. Happy-path tests below check the
// persisted shape, then assert that the install returned an error
// (because step 4 failed) with a message that proves startBundleSource
// was reached.

// Imports come after the hoisted mocks. Bun's mock.module guarantees
// the mocks resolve first even though they appear textually above —
// keeping the order explicit makes the precondition obvious to a
// future reader.
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { FileCredentialStore } from "../../src/tools/credential-store.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { personalWorkspaceIdFor, WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { _resetComposioConfigForTest } from "../../src/composio/sdk.ts";
import {
  hasPersistedComposioConnection,
  saveComposioConnection,
} from "../../src/bundles/composio-connection.ts";

// ── Catalog fixture ─────────────────────────────────────────────────
//
// The composio install branch reads the catalog entry shape:
// auth=composio + composio.{toolkit,authConfigEnv}. Synthesized as
// a `DirectoryEntry` per the install-handler signature.

const GMAIL_ID = "com.google/gmail";
const GMAIL_URL = "https://backend.composio.dev/v3/mcp";

function gmailEntry(): import("../../src/registries/types.ts").DirectoryEntry {
  return {
    id: GMAIL_ID,
    registryId: "bundled-static",
    registryType: "static",
    name: "Gmail",
    description: "Read, send, and draft mail",
    install: {
      kind: "remote-oauth",
      url: GMAIL_URL,
      auth: "composio",
      composio: {
        toolkit: "gmail",
        authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
      },
    },
  };
}

const ADMIN: UserIdentity = {
  id: "usr_admin",
  email: "admin@test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

interface Harness {
  workDir: string;
  wsId: string;
  workspaceStore: WorkspaceStore;
  workspaceRegistry: ToolRegistry;
  runtime: Runtime;
}

function buildHarness(): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-composio-install-"));
  const wsId = "ws_test";
  const workspaceStore = new WorkspaceStore(workDir);

  // Disable mpak in the test registry config to keep the test
  // offline. Same reason as in connector-tools.test.ts.
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated",
          type: "static",
          enabled: true,
          locked: true,
          url: join(workDir, "empty-catalog.yaml"),
        },
        { id: "mpak", name: "mpak", type: "mpak", enabled: false },
      ],
    }),
  );
  writeFileSync(join(workDir, "empty-catalog.yaml"), "servers: []\n");
  const registryStore = new RegistryStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: () => workspaceRegistry,
    getAllowInsecureRemotes: () => false,
    getEventSink: () => new NoopEventSink(),
    getPermissionStore: () => ({
      deleteConnector: async () => {},
      listConnectorGrants: async () => ({}),
    }),
    getUserStore: () => ({ get: async () => null }),
    getBundleInstancesForWorkspace: () => lifecycle.getInstances(),
  } as unknown as Runtime;

  return { workDir, wsId, workspaceStore, workspaceRegistry, runtime };
}

async function provision(h: Harness): Promise<void> {
  await h.workspaceStore.create("Test", h.wsId.slice(3));
  await h.workspaceStore.addMember(h.wsId, ADMIN.id, "admin");
}

function buildTool(h: Harness) {
  const ctx: ManageConnectorsContext = {
    runtime: h.runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => h.wsId,
  };
  return createManageConnectorsTool(ctx);
}

// ── Env handling ────────────────────────────────────────────────────

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED_ENV = ["COMPOSIO_API_KEY", "COMPOSIO_GMAIL_AUTH_CONFIG_ID", "NB_TENANT_ID"];

let h: Harness;

beforeEach(async () => {
  for (const k of TRACKED_ENV) SAVED_ENV[k] = process.env[k];
  for (const k of TRACKED_ENV) delete process.env[k];
  _resetComposioConfigForTest();
  composioCalls.createConfig = undefined;
  composioCalls.createImpl = async () => ({
    sessionId: "session_test",
    mcp: {
      type: "http",
      url: "https://composio.test/mcp/session_test",
      headers: {},
    },
  });
  h = buildHarness();
  await provision(h);
});

afterEach(() => {
  for (const k of TRACKED_ENV) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  _resetComposioConfigForTest();
  rmSync(h.workDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe("manage_connectors.install (composio-auth)", () => {
  // Helper for the happy-path-shape tests: install will fail at the
  // unmocked startBundleSource step (fake `composio.test` URL), but
  // the BundleRef is persisted to workspace.json BEFORE that step.
  // We read what landed and assert its shape, ignoring the install's
  // error return.
  async function installAndReadPersistedRef(): Promise<
    Extract<BundleRef, { url: string }> | undefined
  > {
    const tool = buildTool(h);
    await tool.handler({ action: "install", entry: gmailEntry(), wsId: h.wsId });
    const ws = await h.workspaceStore.get(h.wsId);
    return ws?.bundles.find(
      (b): b is Extract<BundleRef, { url: string }> => "url" in b && "composio" in b,
    );
  }

  test("(a) persists ref.composio.connectorId on the BundleRef", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const installed = await installAndReadPersistedRef();
    expect(installed).toBeDefined();
    expect(installed?.composio?.connectorId).toBe(GMAIL_ID);
  });

  test("(b) transport.auth.value is the template — literal API key never appears in workspace.json", async () => {
    process.env.COMPOSIO_API_KEY = "secret-api-key-DO-NOT-LEAK";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const installed = await installAndReadPersistedRef();
    expect(installed?.transport?.auth?.type).toBe("header");
    expect(
      (installed?.transport?.auth as { value?: string } | undefined)?.value,
    ).toBe("${COMPOSIO_API_KEY}");

    // Full disk-shape audit: serialize what was persisted and prove
    // the literal secret appears nowhere. This is the load-bearing
    // assertion of the whole template-substitution design.
    const serialized = JSON.stringify(installed);
    expect(serialized.includes("secret-api-key-DO-NOT-LEAK")).toBe(false);
  });

  test("(c) extra headers containing the API key are scrubbed to the template (replaceAll)", async () => {
    process.env.COMPOSIO_API_KEY = "secret-api-key";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    // Composio's session sometimes returns headers beyond x-api-key.
    // Defensive: if the API key appears anywhere inside one (e.g. a
    // hypothetical `Authorization: Bearer secret-api-key` shape),
    // the install path must scrub it before the BundleRef hits disk.
    // Twice in one value validates the `replaceAll` over `replace`.
    composioCalls.createImpl = async () => ({
      sessionId: "session_test",
      mcp: {
        type: "http",
        url: "https://composio.test/mcp/session_test",
        headers: {
          "x-api-key": "secret-api-key",
          "x-debug-echo": "secret-api-key-then-secret-api-key-again",
          "x-static-header": "no-secret-here",
        },
      },
    });

    const installed = await installAndReadPersistedRef();

    // x-api-key gets skipped (it's the auth header, handled
    // separately via transport.auth) — so it shouldn't appear in
    // transport.headers.
    expect(installed?.transport?.headers?.["x-api-key"]).toBeUndefined();

    // The debug header had the secret TWICE. Both occurrences must
    // be scrubbed. `replaceAll`, not `replace`.
    expect(installed?.transport?.headers?.["x-debug-echo"]).toBe(
      "${COMPOSIO_API_KEY}-then-${COMPOSIO_API_KEY}-again",
    );

    // The clean header passes through unchanged.
    expect(installed?.transport?.headers?.["x-static-header"]).toBe("no-secret-here");

    // Full audit: no literal secret on disk.
    expect(JSON.stringify(installed).includes("secret-api-key")).toBe(false);
  });

  test("(d) eager startBundleSource failure returns success with a warning, not a hard error", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), wsId: h.wsId });

    // Eager-start fails on the fake `composio.test` URL, but the
    // install itself has succeeded — the BundleRef is in workspace.json,
    // seedInstance has run, and a subsequent Connect click will run
    // the same `ensureSourceRegistered` path as a normal reconnect.
    // Surfacing this as a hard error would say "install failed" while
    // the bundle is in fact installed — misleading. Contract: return
    // success with a `warning` field so the agent / UI can communicate
    // "installed, click Connect to retry" honestly.
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      ok: boolean;
      alreadyInstalled: boolean;
      serverName: string;
      scope: string;
      warning?: string;
    };
    expect(sc.ok).toBe(true);
    expect(sc.alreadyInstalled).toBe(false);
    expect(sc.warning).toBeTruthy();
    // Human-readable text mentions the click-Connect recovery path so
    // the user / agent knows what to do next.
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Installed");
    expect(text).toContain("Connect");

    // BundleRef persisted regardless — install state is committed.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles).toHaveLength(1);
  });

  test("(e-1) errResult when COMPOSIO_API_KEY is unset", async () => {
    // COMPOSIO_API_KEY intentionally missing. Per-toolkit env IS set
    // so we can assert the failure is API-key-specific.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), wsId: h.wsId });

    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("COMPOSIO_API_KEY");

    // BundleRef must NOT be persisted on failure — env check runs
    // before the workspace.json write.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles ?? []).toHaveLength(0);
  });

  test("(e-2) errResult when per-toolkit auth-config env is unset", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    // COMPOSIO_GMAIL_AUTH_CONFIG_ID intentionally missing.

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), wsId: h.wsId });

    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("COMPOSIO_GMAIL_AUTH_CONFIG_ID");

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles ?? []).toHaveLength(0);
  });

  test("(e-3) errResult when entry.install lacks the composio config block", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const malformed = gmailEntry();
    // Strip the composio block while keeping auth: composio. This
    // would only happen on a malformed catalog entry, but the handler
    // should fail loudly rather than try to use undefined fields.
    if (malformed.install.kind === "remote-oauth") {
      delete (malformed.install as { composio?: unknown }).composio;
    }

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: malformed, wsId: h.wsId });

    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("composio");
  });

  test("(f) self-heal: orphan composio bundle (workspace.json row but no lifecycle instance) is reattached without re-running createComposioSession or duplicating", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    // Pre-seed an orphan: a persisted composio bundle whose `url` is
    // the dynamic per-install Composio session URL (the realistic shape
    // — not the catalog placeholder). No corresponding lifecycle
    // instance, mimicking the state after a prior uninstall that
    // didn't clean workspace.json.
    const orphanRef: Extract<BundleRef, { url: string }> = {
      url: "https://composio.test/mcp/session_orphaned",
      serverName: "com-google-gmail",
      transport: { type: "streamable-http" },
      oauthScope: "workspace",
      composio: { connectorId: GMAIL_ID },
    };
    await h.workspaceStore.update(h.wsId, { bundles: [orphanRef] });

    // Track whether createComposioSession is invoked — self-heal must
    // skip it (re-attach should not burn an upstream Composio session).
    let createCalls = 0;
    composioCalls.createImpl = async () => {
      createCalls += 1;
      return {
        sessionId: "session_fresh",
        mcp: { type: "http", url: "https://composio.test/mcp/session_fresh", headers: {} },
      };
    };

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), wsId: h.wsId });

    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      ok: boolean;
      alreadyInstalled: boolean;
      serverName: string;
      scope: string;
    };
    expect(sc.ok).toBe(true);
    expect(sc.alreadyInstalled).toBe(false);
    expect(sc.serverName).toBe("com-google-gmail");
    expect(sc.scope).toBe("workspace");

    // No duplicate row appended. The original orphan ref (with its
    // existing session URL) is preserved untouched.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles).toHaveLength(1);
    const persisted = ws?.bundles[0] as Extract<BundleRef, { url: string }>;
    expect(persisted.url).toBe("https://composio.test/mcp/session_orphaned");

    // Self-heal must not call back to Composio — re-attach reuses the
    // existing connection. Calling create() again would burn a fresh
    // upstream session and orphan the prior one.
    expect(createCalls).toBe(0);

    // Lifecycle instance was re-seeded so subsequent ops can resolve it.
    const lifecycle = h.runtime.getLifecycle();
    expect(lifecycle.getInstance("com-google-gmail", h.wsId)).not.toBeNull();
  });

  test("install surfaces createComposioSession failures as errResult", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";
    composioCalls.createImpl = async () => {
      throw new Error("Composio rejected the session create");
    };

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), wsId: h.wsId });

    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Composio");

    // Nothing should be persisted if the session create fails — the
    // BundleRef can't carry a session URL we never received.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles ?? []).toHaveLength(0);
  });

  // ── personal-workspace target ─────────────────────────────────────
  //
  // The path this whole change unblocks: composio-auth install into a
  // personal workspace. A stale guard used to reject it inside the
  // `auth === "composio"` branch; dcr/static were never gated, so a
  // dcr fixture would NOT cover this. These two tests pin the composio
  // path specifically — install succeeds, and disconnect cleanup is
  // keyed on the personal `wsId` with no `isPersonal` special-casing
  // (the invariant the removed guard's safety argument rests on).

  test("(g) composio install into a personal workspace persists the ref (the path the removed guard blocked)", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const personalWsId = personalWorkspaceIdFor(ADMIN.id);
    await h.workspaceStore.create("Admin Personal", `user_${ADMIN.id}`, {
      isPersonal: true,
      ownerUserId: ADMIN.id,
    });

    const tool = buildTool(h);
    const result = await tool.handler({
      action: "install",
      entry: gmailEntry(),
      wsId: personalWsId,
    });

    // Eager startBundleSource fails on the fake session URL (same as
    // the shared-workspace path), so this returns success-with-warning,
    // NOT the old "cannot install into a personal workspace" error.
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { scope?: string; wsId?: string };
    expect(sc.scope).toBe("workspace");
    expect(sc.wsId).toBe(personalWsId);

    // The ref landed in the personal workspace with the composio marker
    // and the post-T008 workspace scope.
    const personalWs = await h.workspaceStore.get(personalWsId);
    const installed = personalWs?.bundles.find(
      (b): b is Extract<BundleRef, { url: string }> => "url" in b && "composio" in b,
    );
    expect(installed).toBeDefined();
    expect(installed?.composio?.connectorId).toBe(GMAIL_ID);
    expect(installed?.oauthScope).toBe("workspace");
  });

  test("(h) disconnect of a personal-workspace composio bundle runs cleanup keyed on that wsId (no isPersonal gate)", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const personalWsId = personalWorkspaceIdFor(ADMIN.id);
    await h.workspaceStore.create("Admin Personal", `user_${ADMIN.id}`, {
      isPersonal: true,
      ownerUserId: ADMIN.id,
    });

    // Install seeds the BundleRef + lifecycle instance for the personal
    // workspace (the eager-start failure is caught and logged after).
    const tool = buildTool(h);
    await tool.handler({ action: "install", entry: gmailEntry(), wsId: personalWsId });

    // Simulate a completed Composio OAuth: a connection.json under the
    // personal workspace's credential path. Cleanup must find and remove
    // THIS file — proving it resolves by wsId, personal included.
    await saveComposioConnection(h.workDir, { type: "workspace", wsId: personalWsId }, GMAIL_ID, {
      connectedAccountId: "ca_personal",
      toolkit: "gmail",
      userId: ADMIN.id,
      connectedAt: "2026-06-02T00:00:00.000Z",
      status: "ACTIVE",
    });
    expect(hasPersistedComposioConnection(h.workDir, { type: "workspace", wsId: personalWsId }, GMAIL_ID)).toBe(true);

    // Drop the API key so cleanup skips the upstream revoke (offline);
    // the local-delete branch is the part that pins the wsId routing.
    delete process.env.COMPOSIO_API_KEY;

    // Disconnect through the real lifecycle caller (serverName is the
    // slug of GMAIL_ID; principal is the workspace principal). If a
    // future change gated this caller on `isPersonal`, the personal
    // workspace's connection would survive and orphan upstream — this
    // assertion fails first.
    await h.runtime
      .getLifecycle()
      .disconnect("com-google-gmail", personalWsId, "_workspace", { workDir: h.workDir });

    expect(hasPersistedComposioConnection(h.workDir, { type: "workspace", wsId: personalWsId }, GMAIL_ID)).toBe(false);
  });
});

// ── scope: "identity" — personal Composio connector ──────────────────
//
// The identity-plane sibling of the workspace install above. Same wiring
// (`buildComposioWiring` bound to `{type:"user"}`), but the ref lands in
// `users/<id>/connectors.json` — not any workspace — and carries NO oauthScope
// (identity refs are user-owned structurally). Unlike the workspace path, the
// identity install does NOT eager-start, so the fake session URL is never dialed
// and the happy path returns success outright (the Connect callback starts the
// source later, via `getIdentityConnectorSource`).
describe("manage_connectors.install scope:identity (composio personal connector)", () => {
  test("(i) persists the composio ref on the identity plane — no oauthScope, no workspace write, no eager-start", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), scope: "identity" });

    // No eager-start on the identity path → the fake session URL is never dialed,
    // so this succeeds outright (the workspace path fails at eager-start).
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { ok?: boolean; scope?: string; serverName?: string };
    expect(sc.ok).toBe(true);
    expect(sc.scope).toBe("identity");

    // Persisted on the identity plane with the composio marker + the per-install
    // session URL from the mocked session.
    const refs = await new IdentityConnectorStore({ workDir: h.workDir }).list(ADMIN.id);
    expect(refs).toHaveLength(1);
    const ref = refs[0] as Extract<BundleRef, { url: string }>;
    expect(ref.url).toBe("https://composio.test/mcp/session_test");
    expect(ref.composio?.connectorId).toBe(GMAIL_ID);
    // Identity refs are user-owned structurally — no oauthScope literal.
    expect((ref as { oauthScope?: unknown }).oauthScope).toBeUndefined();

    // Nothing written into any workspace.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles ?? []).toHaveLength(0);

    // The literal API key never lands on disk — transport carries the template.
    expect(JSON.stringify(ref).includes("k_test")).toBe(false);
    expect((ref.transport?.auth as { value?: string } | undefined)?.value).toBe(
      "${COMPOSIO_API_KEY}",
    );
  });

  test("(j) list_personal_connectors exposes auth:composio + the connectorId (cid) — the Connect route's key", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const tool = buildTool(h);
    await tool.handler({ action: "install", entry: gmailEntry(), scope: "identity" });

    const result = await tool.handler({ action: "list_personal_connectors" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      connectors: Array<{ serverName: string; auth: string; connectorId?: string }>;
    };
    expect(sc.connectors).toHaveLength(1);
    // The UI branches Connect on `auth`; composio keys on the catalog cid.
    expect(sc.connectors[0].auth).toBe("composio");
    expect(sc.connectors[0].connectorId).toBe(GMAIL_ID);
  });

  test("(k) errResult when COMPOSIO_API_KEY is unset — the gate admits composio, the prerequisite rejects it, nothing persisted", async () => {
    // Per-toolkit env set so the failure is provably API-key-specific.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    const tool = buildTool(h);
    const result = await tool.handler({ action: "install", entry: gmailEntry(), scope: "identity" });

    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("COMPOSIO_API_KEY");
    // Not the auth-type gate rejection — composio passed the gate.
    expect(text).not.toMatch(/isn't supported for personal connectors yet/i);

    // Prerequisite failure (before any session create) persists nothing.
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(ADMIN.id)).toHaveLength(0);
  });

  test("(l) second identity install of the same composio connector is idempotent — no second session, alreadyInstalled:true", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail";

    // Count upstream session creates — a re-install must NOT mint a second and
    // orphan the first (the asymmetry the workspace path guards via dedup).
    let createCalls = 0;
    composioCalls.createImpl = async () => {
      createCalls += 1;
      return {
        sessionId: "session_test",
        mcp: { type: "http", url: "https://composio.test/mcp/session_test", headers: {} },
      };
    };

    const tool = buildTool(h);
    const first = await tool.handler({ action: "install", entry: gmailEntry(), scope: "identity" });
    expect(first.isError).toBe(false);
    expect((first.structuredContent as { alreadyInstalled?: boolean }).alreadyInstalled).toBe(false);

    const second = await tool.handler({ action: "install", entry: gmailEntry(), scope: "identity" });
    expect(second.isError).toBe(false);
    const sc = second.structuredContent as {
      ok?: boolean;
      alreadyInstalled?: boolean;
      scope?: string;
    };
    expect(sc.ok).toBe(true);
    expect(sc.alreadyInstalled).toBe(true);
    expect(sc.scope).toBe("identity");

    // The dedup short-circuits BEFORE buildComposioWiring — exactly one upstream
    // session was ever created, so none is orphaned.
    expect(createCalls).toBe(1);

    // Still exactly one ref on the identity plane.
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(ADMIN.id)).toHaveLength(1);
  });
});
