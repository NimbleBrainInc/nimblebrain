import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { FileCredentialStore } from "../../src/tools/credential-store.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

/**
 * Coverage for the new actions on `manage_connectors` introduced with
 * static-auth (operator-configured OAuth apps):
 *
 *   - `setup_operator` — admin-only upsert of (clientId, clientSecret)
 *   - `remove_operator_setup` — admin-only teardown, install-aware
 *   - `list_directory` — `operatorConfigured` flag for static entries
 *   - `install` for static-auth — refuses when setup is missing, persists
 *     the credential ref in the workspace BundleRef on success
 *
 * The handlers only touch a small slice of `Runtime`: `getWorkspaceStore`,
 * `getWorkDir`, `getRegistryStore`, `getLifecycle`, `getRegistryForWorkspace`.
 * We build a thin stub around real WorkspaceStore / FileCredentialStore /
 * RegistryStore / BundleLifecycleManager / ToolRegistry instances —
 * sufficient to drive the production code without spinning up a full
 * `Runtime.start()` (which would pull in identity, model, transport, etc.).
 */

const ASANA_ID = "asana";
const ASANA_URL = "https://mcp.asana.com/v2/mcp";
const ASANA_SECRET_KEY = "asana.client_secret";

const ADMIN_USER: UserIdentity = {
  id: "usr_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

const NON_ADMIN_USER: UserIdentity = {
  id: "usr_member",
  email: "member@example.test",
  displayName: "Member",
  orgRole: "member",
  preferences: {},
};

interface Harness {
  workDir: string;
  wsId: string;
  workspaceStore: WorkspaceStore;
  credStore: FileCredentialStore;
  registryStore: RegistryStore;
  lifecycle: BundleLifecycleManager;
  workspaceRegistry: ToolRegistry;
  runtime: Runtime;
}

/**
 * Build a stub Runtime exposing the methods the connector-tool handlers
 * actually call. Cast to `Runtime` at the boundary — the type widens to
 * what the production `ManageConnectorsContext` declares without forcing
 * us to satisfy 100+ unrelated methods.
 */
function buildHarness(opts: { adminId?: string } = {}): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-tools-"));
  const wsId = "ws_acme";
  const workspaceStore = new WorkspaceStore(workDir);
  const credStore = new FileCredentialStore(workDir);
  const registryStore = new RegistryStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getRegistryStore: () => registryStore,
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
  } as unknown as Runtime;

  return {
    workDir,
    wsId,
    workspaceStore,
    credStore,
    registryStore,
    lifecycle,
    workspaceRegistry,
    runtime,
  };
}

async function provisionWorkspace(
  h: Harness,
  members: Array<{ userId: string; role: "admin" | "member" }> = [
    { userId: ADMIN_USER.id, role: "admin" },
    { userId: NON_ADMIN_USER.id, role: "member" },
  ],
): Promise<void> {
  const slug = h.wsId.startsWith("ws_") ? h.wsId.slice(3) : h.wsId;
  await h.workspaceStore.create("Acme", slug);
  for (const m of members) {
    await h.workspaceStore.addMember(h.wsId, m.userId, m.role);
  }
}

function buildTool(
  h: Harness,
  identity: UserIdentity | null,
  wsIdOverride?: string | null,
) {
  const ctx: ManageConnectorsContext = {
    runtime: h.runtime,
    getIdentity: () => identity,
    getWorkspaceId: () => (wsIdOverride === undefined ? h.wsId : wsIdOverride),
  };
  return createManageConnectorsTool(ctx);
}

interface StructuredResult {
  ok?: boolean;
  error?: string;
  catalogId?: string;
  clientId?: string;
  serverName?: string;
  scope?: string;
  alreadyInstalled?: boolean;
  entries?: Array<{
    id: string;
    registryId: string;
    operatorConfigured?: boolean;
  }>;
  errors?: Array<{ registryId: string; message: string }>;
}

function structured(result: { structuredContent?: unknown }): StructuredResult {
  return (result.structuredContent ?? {}) as StructuredResult;
}

// ─────────────────────────────────────────────────────────────────────
// setup_operator
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.setup_operator", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    const tool = buildTool(h, NON_ADMIN_USER);
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-1",
      clientSecret: "sec-1",
    });

    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("on success persists clientId in workspace.json AND clientSecret in credential store", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-public",
      clientSecret: "sec-private",
    });

    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
    expect(structured(result).clientId).toBe("cid-public");

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[ASANA_ID]?.clientId).toBe("cid-public");
    expect(ws?.oauthOperatorApps?.[ASANA_ID]?.configuredBy).toBe(ADMIN_USER.id);

    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped?.reveal()).toBe("sec-private");
  });

  test("upsert: calling twice updates both clientId and clientSecret", async () => {
    const tool = buildTool(h, ADMIN_USER);

    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-v1",
      clientSecret: "sec-v1",
    });
    const second = await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-v2",
      clientSecret: "sec-v2",
    });

    expect(second.isError).toBe(false);
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[ASANA_ID]?.clientId).toBe("cid-v2");
    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped?.reveal()).toBe("sec-v2");
  });

  test("rejects missing wsId / catalogId / clientId / clientSecret", async () => {
    const noWs = buildTool(h, ADMIN_USER, null);
    expect(
      (
        await noWs.handler({
          action: "setup_operator",
          catalogId: ASANA_ID,
          clientId: "x",
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);

    const tool = buildTool(h, ADMIN_USER);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          clientId: "x",
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          catalogId: ASANA_ID,
          clientSecret: "y",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await tool.handler({
          action: "setup_operator",
          catalogId: ASANA_ID,
          clientId: "x",
        })
      ).isError,
    ).toBe(true);
  });

  test("rejects unknown workspace and unknown catalog entry", async () => {
    const fakeWs = buildTool(h, ADMIN_USER, "ws_nonexistent");
    const r1 = await fakeWs.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "x",
      clientSecret: "y",
    });
    expect(r1.isError).toBe(true);

    const tool = buildTool(h, ADMIN_USER);
    const r2 = await tool.handler({
      action: "setup_operator",
      catalogId: "no-such-entry",
      clientId: "x",
      clientSecret: "y",
    });
    expect(r2.isError).toBe(true);
  });

  test("rejects DCR (non-static-auth) entries — operator setup is meaningless there", async () => {
    const tool = buildTool(h, ADMIN_USER);
    // notion-org is auth: "dcr" in the default catalog
    const result = await tool.handler({
      action: "setup_operator",
      catalogId: "notion-org",
      clientId: "x",
      clientSecret: "y",
    });
    expect(result.isError).toBe(true);
  });

  test("rolls back the credential write when workspace.json update fails (no prior secret)", async () => {
    // Force the workspace update to fail after the credential write
    // has landed. The handler must delete the orphaned credential so
    // the two stores stay in lockstep.
    const original = h.workspaceStore.update.bind(h.workspaceStore);
    h.workspaceStore.update = async () => {
      throw new Error("simulated workspace.json failure");
    };
    const tool = buildTool(h, ADMIN_USER);
    await expect(
      tool.handler({
        action: "setup_operator",
        catalogId: ASANA_ID,
        clientId: "cid-orphan",
        clientSecret: "sec-orphan",
      }),
    ).rejects.toThrow("simulated workspace.json failure");
    h.workspaceStore.update = original;

    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped).toBeNull();
  });

  test("rotation: workspace.json failure does NOT clobber a pre-existing secret", async () => {
    // Seed a working setup, then simulate failure on the rotate call.
    // The rollback must be skipped — wiping a still-valid credential
    // because the rotate's metadata write hiccupped is worse UX than
    // leaving the prior secret in place.
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-v1",
      clientSecret: "sec-v1",
    });

    const original = h.workspaceStore.update.bind(h.workspaceStore);
    h.workspaceStore.update = async () => {
      throw new Error("simulated workspace.json failure on rotate");
    };
    await expect(
      tool.handler({
        action: "setup_operator",
        catalogId: ASANA_ID,
        clientId: "cid-v2",
        clientSecret: "sec-v2",
      }),
    ).rejects.toThrow("simulated workspace.json failure on rotate");
    h.workspaceStore.update = original;

    // Credential store now holds the new secret (the put already
    // landed before the failure) — but it's NOT been deleted, because
    // there was a prior valid secret under the same key.
    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped?.reveal()).toBe("sec-v2");
  });
});

// ─────────────────────────────────────────────────────────────────────
// remove_operator_setup
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.remove_operator_setup", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("returns permission_denied when caller is not workspace admin", async () => {
    // Seed setup as admin first so the gate is what fails (not "no setup").
    const adminTool = buildTool(h, ADMIN_USER);
    await adminTool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const memberTool = buildTool(h, NON_ADMIN_USER);
    const result = await memberTool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toBe("permission_denied");
  });

  test("errors when no setup exists for the catalog entry", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(true);
  });

  test("refuses while the connector is currently installed in workspace.bundles", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    // Simulate an installed connector by appending the BundleRef directly.
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws).not.toBeNull();
    await h.workspaceStore.update(h.wsId, {
      bundles: [
        ...(ws?.bundles ?? []),
        { url: ASANA_URL, serverName: ASANA_ID } as BundleRef,
      ],
    });

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(true);
  });

  test("on success removes both clientId from workspace.json and the credential", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);

    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.oauthOperatorApps?.[ASANA_ID]).toBeUndefined();
    const wrapped = await h.credStore.get(h.wsId, ASANA_SECRET_KEY);
    expect(wrapped).toBeNull();
  });

  test("succeeds on a workspace where the bundle was never installed", async () => {
    // `bundles[]` empty + setup configured + no install ⇒ removable.
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });
    const ws = await h.workspaceStore.get(h.wsId);
    expect(ws?.bundles).toEqual([]);

    const result = await tool.handler({
      action: "remove_operator_setup",
      catalogId: ASANA_ID,
    });
    expect(result.isError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// list_directory — operatorConfigured flag for static entries
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.list_directory", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("aggregates entries across enabled registries (curated + mpak by default)", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "list_directory" });
    expect(result.isError).toBe(false);
    const entries = structured(result).entries ?? [];

    const fromCurated = entries.filter((e) => e.registryId === "curated");
    expect(fromCurated.length).toBeGreaterThan(0);
    // mpak is enabled by default but may fail offline — accept either
    // entries or a recorded error so the test stays hermetic.
    const errs = structured(result).errors ?? [];
    const fromMpak = entries.filter((e) => e.registryId === "mpak");
    expect(fromMpak.length > 0 || errs.some((x) => x.registryId === "mpak")).toBe(true);
  });

  test("static entry shows operatorConfigured: false before setup_operator runs", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "list_directory" });
    const asana = (structured(result).entries ?? []).find(
      (e) => e.registryId === "curated" && e.id === ASANA_ID,
    );
    expect(asana).toBeDefined();
    expect(asana?.operatorConfigured).toBe(false);
  });

  test("static entry shows operatorConfigured: true after setup_operator runs", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid",
      clientSecret: "sec",
    });

    const result = await tool.handler({ action: "list_directory" });
    const asana = (structured(result).entries ?? []).find(
      (e) => e.registryId === "curated" && e.id === ASANA_ID,
    );
    expect(asana?.operatorConfigured).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// install — static-auth path
// ─────────────────────────────────────────────────────────────────────

describe("manage_connectors.install (static-auth)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("errors with a setup pointer when oauthOperatorApps[id] is missing", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", catalogId: ASANA_ID });
    expect(result.isError).toBe(true);
    // The error message names the portal / Set up affordance.
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("set up");
  });

  test("errors when clientId is configured but the credential is missing", async () => {
    // Stamp the public clientId without a credential — simulates a corrupted
    // half-setup (e.g., the credentials directory was wiped).
    await h.workspaceStore.update(h.wsId, {
      oauthOperatorApps: {
        [ASANA_ID]: {
          clientId: "cid-only",
          configuredAt: new Date().toISOString(),
          configuredBy: ADMIN_USER.id,
        },
      },
    });

    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({ action: "install", catalogId: ASANA_ID });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text.toLowerCase()).toContain("client_secret");
  });

  test("on success the BundleRef in workspace.bundles carries oauthClient pointing at the credential", async () => {
    const tool = buildTool(h, ADMIN_USER);
    await tool.handler({
      action: "setup_operator",
      catalogId: ASANA_ID,
      clientId: "cid-public",
      clientSecret: "sec-private",
    });

    const result = await tool.handler({ action: "install", catalogId: ASANA_ID });
    expect(result.isError).toBe(false);
    expect(structured(result).ok).toBe(true);
    expect(structured(result).serverName).toBe(ASANA_ID);

    const ws = await h.workspaceStore.get(h.wsId);
    const installed = ws?.bundles.find(
      (b): b is Extract<BundleRef, { url: string }> => "url" in b && b.url === ASANA_URL,
    );
    expect(installed).toBeDefined();
    expect(installed?.oauthClient?.clientId).toBe("cid-public");
    expect(installed?.oauthClient?.clientSecret).toEqual({
      ref: "credential",
      key: ASANA_SECRET_KEY,
    });
  });
});

describe("manage_connectors.set_permissions", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provisionWorkspace(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("rejects unknown serverName — fail-fast on typos", async () => {
    const tool = buildTool(h, ADMIN_USER);
    const result = await tool.handler({
      action: "set_permissions",
      serverName: "not-installed",
      scope: "workspace",
      tools: { read: "disallow" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("not installed");
  });
});
