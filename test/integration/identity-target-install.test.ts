import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Scope of the slice under test: DCR (standard OAuth) connectors only. Composio
 * / static / provider auth are workspace/platform-bound and rejected here — a
 * separate slice. The collision rule ("a serverName can't be both a personal
 * connector and a shared-workspace install") is enforced at both install points.
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
    }),
    getAllowInsecureRemotes: () => false,
  } as unknown as Runtime;

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => USER,
    getWorkspaceId: () => sharedWsId,
  };
  return { workDir, sharedWsId, tool: createManageConnectorsTool(ctx) };
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

  test("rejects a composio remote-oauth entry — DCR-only on the identity plane for now", async () => {
    const result = await h.tool.handler({
      action: "install",
      entry: composioEntry(),
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

  test("offers personal DCR connectors; excludes non-personal and non-DCR", async () => {
    const result = await h.tool.handler({ action: "list_personal_catalog" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as {
      catalog: Array<{ id: string; personal?: boolean; install: { auth?: string } }>;
    };
    const ids = sc.catalog.map((e) => e.id);
    // Granola: dcr + personal → offered.
    expect(ids).toContain("ai.granola/mcp");
    // Notion: dcr but NOT flagged personal → excluded.
    expect(ids).not.toContain("com.notion/mcp");
    // Dropbox: flagged personal but static (non-DCR) → excluded; DCR is the hard gate.
    expect(ids).not.toContain("com.dropbox/mcp");
    // Everything offered is a DCR remote MCP connection.
    for (const e of sc.catalog) expect(e.install.auth).toBe("dcr");
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
