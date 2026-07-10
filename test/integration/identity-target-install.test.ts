import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { DirectoryEntry } from "../../src/registries/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";

/**
 * Integration coverage for `manage_connectors.install` with `scope: "identity"`
 * — installing a personal connector on the caller's own identity plane
 * (`users/<id>/connectors.json`) instead of into a workspace.
 *
 * Scope of the slice under test: DCR (standard OAuth) and composio connectors.
 * static / provider auth are workspace/platform-bound and rejected here — a
 * separate slice. The composio session-creation path needs a module-level SDK
 * mock, so its happy path lives in the unit suite
 * (`connector-tools-composio-install.test.ts`); here we pin the gate (composio is
 * admitted, and fails on the missing platform prerequisite, not the auth type).
 * The collision rule ("a serverName can't be both a personal connector and a
 * shared-workspace install") is enforced at both install points.
 */

const USER: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.test",
  displayName: "Alice",
  orgRole: "member",
  preferences: {},
};

function dcrEntry(): DirectoryEntry {
  return {
    id: "ai.granola/mcp",
    registryId: "bundled-static",
    registryType: "static",
    name: "Granola",
    description: "Meeting notes",
    install: {
      kind: "remote-oauth",
      url: "https://api.granola.test/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

function composioEntry(): DirectoryEntry {
  return {
    id: "com.example/gmail",
    registryId: "bundled-static",
    registryType: "static",
    name: "Gmail",
    description: "Email",
    install: {
      kind: "remote-oauth",
      url: "https://mcp.composio.test/gmail",
      transportType: "streamable-http",
      auth: "composio",
      composio: { toolkit: "gmail", authConfigEnv: "COMPOSIO_TEST_AUTH" },
    },
  };
}

function mpakEntry(): DirectoryEntry {
  return {
    id: "dev.example/tool",
    registryId: "bundled-static",
    registryType: "static",
    name: "Some Tool",
    description: "An mpak bundle",
    install: { kind: "mpak-bundle", package: "@example/tool" },
  };
}

interface Harness {
  workDir: string;
  sharedWsId: string;
  grants: Record<string, string[]>;
  tool: ReturnType<typeof createManageConnectorsTool>;
}

async function buildHarness(): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-identity-install-"));

  // Disable mpak so ConnectorDirectory doesn't try to fetch; serve the curated
  // fixture catalog statically.
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated services",
          type: "static",
          enabled: true,
          locked: true,
          url: CONNECTOR_FIXTURE_DIR,
        },
        { id: "mpak", name: "mpak.dev", type: "mpak", enabled: false },
      ],
    }),
  );

  const workspaceStore = new WorkspaceStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();
  const registryStore = new RegistryStore(workDir);

  // One shared workspace (admin) + the caller's personal workspace.
  await workspaceStore.create("Helix", "helix");
  const sharedWsId = "ws_helix";
  await workspaceStore.addMember(sharedWsId, USER.id, "admin");
  await workspaceStore.create("Personal", `user_${USER.id}`, {
    isPersonal: true,
    ownerUserId: USER.id,
  });

  const grants: Record<string, string[]> = {};
  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getWorkspaceContext: (id: string) => new WorkspaceContext({ wsId: id, workDir }),
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => workspaceRegistry,
    getPermissionStore: () => ({
      deleteConnector: async () => {},
      listConnectorGrants: async (_userId: string) => grants,
      getConnectorGrants: async (_userId: string, serverName: string) => grants[serverName] ?? [],
      grantConnector: async (_userId: string, serverName: string, wsId: string) => {
        grants[serverName] = [...(grants[serverName] ?? []), wsId];
      },
      revokeConnector: async (_userId: string, serverName: string, wsId: string) => {
        const remaining = (grants[serverName] ?? []).filter((id) => id !== wsId);
        if (remaining.length === 0) delete grants[serverName];
        else grants[serverName] = remaining;
      },
    }),
    getAllowInsecureRemotes: () => false,
  } as unknown as Runtime;

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => USER,
    getWorkspaceId: () => sharedWsId,
  };
  return { workDir, sharedWsId, grants, tool: createManageConnectorsTool(ctx) };
}

function resultText(result: { content?: unknown }): string {
  const content = result.content as Array<{ text?: string }> | undefined;
  return content?.[0]?.text ?? "";
}

describe("manage_connectors.install scope:identity — DCR personal-connector install", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("writes users/<id>/connectors.json and reports scope:identity", async () => {
    const result = await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { scope?: string; serverName?: string; ok?: boolean };
    expect(sc.ok).toBe(true);
    expect(sc.scope).toBe("identity");

    // Persisted on the identity plane — not into any workspace.
    const refs = await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id);
    expect(refs).toHaveLength(1);
    const ref = refs[0] as { url?: string; oauthScope?: unknown };
    expect(ref.url).toBe("https://api.granola.test/mcp");
    // Identity refs are user-owned structurally and carry NO oauthScope literal.
    expect(ref.oauthScope).toBeUndefined();
    // Fresh install reports alreadyInstalled:false (symmetric with the dup path).
    expect((result.structuredContent as { alreadyInstalled?: boolean }).alreadyInstalled).toBe(
      false,
    );
  });

  test("re-installing an already-installed connector is idempotent (alreadyInstalled:true, one ref)", async () => {
    const first = await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    expect(first.isError).toBe(false);

    const second = await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    expect(second.isError).toBe(false);
    const sc = second.structuredContent as { ok?: boolean; alreadyInstalled?: boolean };
    expect(sc.ok).toBe(true);
    expect(sc.alreadyInstalled).toBe(true);

    // Upsert-idempotent: still exactly one ref (no duplicate row).
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(1);
  });

  test("list_personal_connectors reads the identity plane after an identity install", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const result = await h.tool.handler({ action: "list_personal_connectors" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      connectors: Array<{ serverName: string; state: string; grantedWorkspaces: string[] }>;
    };
    expect(sc.connectors).toHaveLength(1);
    // Resting state for an installed-but-not-yet-connected personal connector.
    expect(sc.connectors[0].state).toBe("not_authenticated");
    expect(sc.connectors[0].grantedWorkspaces).toEqual([]);
  });

  test("rejects a non-remote-oauth entry — personal connectors are remote MCP connections", async () => {
    const result = await h.tool.handler({ action: "install", entry: mpakEntry(), scope: "identity" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/remote MCP connection/i);
    // Nothing written to the identity plane.
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
  });

  test("rejects a connector whose slug is a reserved system name (nb) — nothing persisted", async () => {
    // A DCR entry whose id slugifies to `nb` would surface its tools as `nb__…`
    // in the trusted system band. Install refuses it at the boundary, so no
    // reserved-name record ever reaches connectors.json.
    const reserved: DirectoryEntry = {
      id: "nb",
      registryId: "bundled-static",
      registryType: "static",
      name: "Reserved",
      description: "collides with the system-tool prefix",
      install: {
        kind: "remote-oauth",
        url: "https://reserved.test/mcp",
        transportType: "streamable-http",
        auth: "dcr",
      },
    };
    const result = await h.tool.handler({ action: "install", entry: reserved, scope: "identity" });
    expect(result.isError).toBe(true);
    expect(resultText(result).toLowerCase()).toContain("reserved");
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
  });

  test("admits a composio entry at the gate — fails on the missing prerequisite, not the auth type", async () => {
    // Deterministically drive the no-key path: composio passes the gate, then
    // `validateComposioInstall` rejects because COMPOSIO_API_KEY is unset. (The
    // happy path — a real session + persisted ref — lives in the unit suite,
    // which mocks the Composio SDK.)
    const savedKey = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    try {
      const result = await h.tool.handler({
        action: "install",
        entry: composioEntry(),
        scope: "identity",
      });
      expect(result.isError).toBe(true);
      // NOT the old gate rejection — composio is no longer refused by auth type.
      expect(resultText(result)).not.toMatch(/isn't supported for personal connectors yet/i);
      // It got past the gate and hit the platform prerequisite check.
      expect(resultText(result)).toMatch(/COMPOSIO_API_KEY/);
      // A prerequisite failure persists nothing to the identity plane.
      expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
    } finally {
      if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
      else process.env.COMPOSIO_API_KEY = savedKey;
    }
  });

  test("rejects a static remote-oauth entry — static is workspace-bound", async () => {
    const staticEntry = composioEntry();
    staticEntry.id = "com.dropbox/mcp";
    staticEntry.name = "Dropbox";
    if (staticEntry.install.kind === "remote-oauth") {
      staticEntry.install.auth = "static";
      delete (staticEntry.install as { composio?: unknown }).composio;
    }
    const result = await h.tool.handler({
      action: "install",
      entry: staticEntry,
      scope: "identity",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/isn't supported for personal connectors yet/i);
  });

  describe("forbid the collision (both install directions)", () => {
    test("shared-workspace install then identity install of the same connector → rejected", async () => {
      const shared = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        wsId: h.sharedWsId,
      });
      expect(shared.isError).toBe(false);

      const identity = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        scope: "identity",
      });
      expect(identity.isError).toBe(true);
      expect(resultText(identity)).toMatch(/already installed as a connector in a workspace/i);
      // The rejected identity install wrote nothing.
      expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
    });

    test("identity install then shared-workspace install of the same connector → rejected", async () => {
      const identity = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        scope: "identity",
      });
      expect(identity.isError).toBe(false);

      const shared = await h.tool.handler({
        action: "install",
        entry: dcrEntry(),
        wsId: h.sharedWsId,
      });
      expect(shared.isError).toBe(true);
      expect(resultText(shared)).toMatch(/already one of your personal connectors/i);
    });
  });
});

describe("manage_connectors.list_personal_catalog — the curated personal-connect set", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("offers personal DCR + composio connectors; excludes non-personal and static", async () => {
    const result = await h.tool.handler({ action: "list_personal_catalog" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      catalog: Array<{ id: string; personal?: boolean; install: { auth?: string } }>;
    };
    const ids = sc.catalog.map((e) => e.id);
    // Granola: dcr + personal → offered.
    expect(ids).toContain("ai.granola/mcp");
    // Asana: composio + personal → offered (the widened gate).
    expect(ids).toContain("io.asana/mcp");
    // Notion: dcr but NOT flagged personal → excluded.
    expect(ids).not.toContain("com.notion/mcp");
    // Dropbox: flagged personal but static → excluded; static stays workspace-bound.
    expect(ids).not.toContain("com.dropbox/mcp");
    // Everything offered is a DCR or composio remote MCP connection — lockstep
    // with the install gate.
    for (const e of sc.catalog) expect(["dcr", "composio"]).toContain(e.install.auth);
  });

  test("drops connectors already installed on the caller's identity", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const result = await h.tool.handler({ action: "list_personal_catalog" });
    const ids = (result.structuredContent as { catalog: Array<{ id: string }> }).catalog.map(
      (e) => e.id,
    );
    // `dcrEntry()` slugs to the same serverName as the fixture's Granola, so the
    // now-installed connector is no longer offered.
    expect(ids).not.toContain("ai.granola/mcp");
  });
});

describe("startIdentityAuth reserved-name guard", () => {
  test("rejects a reserved serverName (nb) before any wiring", async () => {
    // Defense-in-depth mirroring `startBundleSource`: the interactive Connect
    // path builds its source directly (outside startBundleSource), so it
    // enforces the reserved-name invariant itself. Install already blocks such a
    // record, so reaching here means a hand-edited connectors.json — it must
    // still fail closed before constructing a source named `nb`.
    const workDir = mkdtempSync(join(tmpdir(), "nb-startauth-reserved-"));
    try {
      const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
      await expect(lifecycle.startIdentityAuth("nb", USER.id, { workDir })).rejects.toThrow(
        /reserved/i,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("manage_connectors.disconnect scope:identity — full remove", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  const SERVER = "ai-granola-mcp"; // slugifyServerName("ai.granola/mcp")

  test("removes the install record, revokes all grants, and deletes identity credentials", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    await h.tool.handler({ action: "grant_connector", serverName: SERVER, wsId: h.sharedWsId });

    // Simulate a completed OAuth: tokens under the identity mcp-oauth root.
    const oauthDir = join(h.workDir, "users", USER.id, "credentials", "mcp-oauth", SERVER);
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, "tokens.json"), JSON.stringify({ access_token: "x" }));

    const store = new IdentityConnectorStore({ workDir: h.workDir });
    expect(await store.list(USER.id)).toHaveLength(1);
    expect(h.grants[SERVER]).toEqual([h.sharedWsId]);

    const result = await h.tool.handler({
      action: "disconnect",
      serverName: SERVER,
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      ok?: boolean;
      scope?: string;
      revokedWorkspaces?: number;
    };
    expect(sc.ok).toBe(true);
    expect(sc.scope).toBe("identity");
    expect(sc.revokedWorkspaces).toBe(1);

    // Install record gone → offered again by the catalog.
    expect(await store.list(USER.id)).toHaveLength(0);
    // Every grant revoked.
    expect(h.grants[SERVER]).toBeUndefined();
    // Identity credentials deleted.
    expect(existsSync(oauthDir)).toBe(false);
  });

  test("errors on a connector that isn't installed on the identity", async () => {
    const result = await h.tool.handler({
      action: "disconnect",
      serverName: "not-installed",
      scope: "identity",
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/not one of your personal connectors/i);
  });

  test("disconnect with no grants succeeds (revokedWorkspaces: 0)", async () => {
    await h.tool.handler({ action: "install", entry: dcrEntry(), scope: "identity" });
    const result = await h.tool.handler({
      action: "disconnect",
      serverName: SERVER,
      scope: "identity",
    });
    expect(result.isError).toBe(false);
    expect((result.structuredContent as { revokedWorkspaces?: number }).revokedWorkspaces).toBe(0);
    expect(await new IdentityConnectorStore({ workDir: h.workDir }).list(USER.id)).toHaveLength(0);
  });
});
