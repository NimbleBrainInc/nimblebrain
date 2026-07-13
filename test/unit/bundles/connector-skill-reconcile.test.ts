import { describe, expect, it } from "bun:test";
import {
  bootReconcileConnectorSkills,
  type ConnectorSkillReconcileDeps,
  reconcileConnectorSkills,
} from "../../../src/bundles/connector-skill-reconcile.ts";
import type { BundleRef, ConnectorSkillLockEntry } from "../../../src/bundles/types.ts";
import type { ConnectorCatalogEntry } from "../../../src/registries/projection.ts";

const PIN = "v0.3.0";

function lock(identity: string, version: string): ConnectorSkillLockEntry {
  return { identity, version, sha: `sha-${version}`, path: `/ws/connector-skills/${identity}.md` };
}

function connector(fields: {
  url?: string;
  serverName: string;
  skillsLock?: ConnectorSkillLockEntry[];
  composio?: { connectorId: string };
}): BundleRef {
  return {
    url: fields.url ?? "https://example.test/mcp",
    serverName: fields.serverName,
    ...(fields.skillsLock ? { skillsLock: fields.skillsLock } : {}),
    ...(fields.composio ? { composio: fields.composio } : {}),
  };
}

function catalog(entries: Record<string, Partial<ConnectorCatalogEntry>>): Map<string, ConnectorCatalogEntry> {
  return new Map(Object.entries(entries)) as unknown as Map<string, ConnectorCatalogEntry>;
}

interface Captured {
  syncCalls: Array<{ identity: string; serverName: string; wsId: string }>;
  persisted: Array<{ wsId: string; bundles: BundleRef[] }>;
}

function buildDeps(
  workspaces: Array<{ id: string; bundles: BundleRef[] }>,
  syncImpl: (identity: string, serverName: string) => ConnectorSkillLockEntry[],
  opts: {
    byId?: Map<string, ConnectorCatalogEntry>;
    byUrl?: Map<string, ConnectorCatalogEntry>;
  } = {},
): { deps: ConnectorSkillReconcileDeps; cap: Captured } {
  const cap: Captured = { syncCalls: [], persisted: [] };
  const deps: ConnectorSkillReconcileDeps = {
    pinnedVersion: PIN,
    workDir: "/wd",
    listWorkspaces: async () => workspaces,
    updateWorkspaceBundles: async (wsId, bundles) => {
      cap.persisted.push({ wsId, bundles });
    },
    syncBoundSkills: async (identity, serverName, wsId) => {
      cap.syncCalls.push({ identity, serverName, wsId });
      return syncImpl(identity, serverName);
    },
    catalogByIdMap: async () => opts.byId ?? new Map(),
    catalogByUrl: async () => opts.byUrl ?? new Map(),
  };
  return { deps, cap };
}

function skillsLockOf(ref: BundleRef): ConnectorSkillLockEntry[] | undefined {
  return "skillsLock" in ref ? ref.skillsLock : undefined;
}

describe("reconcileConnectorSkills", () => {
  it("refreshes a stale connector, skips one at the pin, passes non-connectors through", async () => {
    const stale = connector({ serverName: "com-outlook-mcp", skillsLock: [lock("outlook", "v0.2.0")] });
    const current = connector({ serverName: "com-gmail-mcp", skillsLock: [lock("gmail", PIN)] });
    const registry = { name: "@nimblebraininc/synapse-crm" } as BundleRef;
    const { deps, cap } = buildDeps(
      [{ id: "ws_a", bundles: [stale, current, registry] }],
      (identity) => [lock(identity, PIN)],
    );

    const result = await reconcileConnectorSkills(deps);

    // Only the stale connector synced — reusing its authoritative lock identity.
    expect(cap.syncCalls).toEqual([
      { identity: "outlook", serverName: "com-outlook-mcp", wsId: "ws_a" },
    ]);
    expect(result).toEqual({ workspacesScanned: 1, connectorsRefreshed: 1 });
    expect(cap.persisted).toHaveLength(1);

    const persisted = cap.persisted[0]!.bundles;
    const updatedStale = persisted.find((b) => "serverName" in b && b.serverName === "com-outlook-mcp");
    expect(skillsLockOf(updatedStale!)?.[0]?.version).toBe(PIN);
    // Untouched entries survive verbatim.
    expect(persisted.some((b) => "name" in b && b.name === "@nimblebraininc/synapse-crm")).toBe(true);
  });

  it("is a no-op (no sync, no persist) when every connector is already at the pin", async () => {
    const current = connector({ serverName: "com-gmail-mcp", skillsLock: [lock("gmail", PIN)] });
    const { deps, cap } = buildDeps([{ id: "ws_a", bundles: [current] }], () => [lock("gmail", PIN)]);

    const result = await reconcileConnectorSkills(deps);

    expect(cap.syncCalls).toHaveLength(0);
    expect(cap.persisted).toHaveLength(0);
    expect(result).toEqual({ workspacesScanned: 1, connectorsRefreshed: 0 });
  });

  it("first-binds a DCR connector (no lock), deriving the identity from the canonical catalog name", async () => {
    const dcr = connector({ url: "https://api.dropbox.test/mcp", serverName: "com-dropbox-mcp" });
    const { deps, cap } = buildDeps(
      [{ id: "ws_a", bundles: [dcr] }],
      (identity) => (identity === "dropbox" ? [lock("dropbox", PIN)] : []),
      { byUrl: catalog({ "https://api.dropbox.test/mcp": { id: "com.dropbox/mcp" } }) },
    );

    const result = await reconcileConnectorSkills(deps);

    // com.dropbox/mcp -> "dropbox" (NOT the slug com-dropbox-mcp).
    expect(cap.syncCalls[0]!.identity).toBe("dropbox");
    expect(result.connectorsRefreshed).toBe(1);
    expect(skillsLockOf(cap.persisted[0]!.bundles[0]!)?.[0]?.identity).toBe("dropbox");
  });

  it("first-binds a composio connector using the toolkit from the catalog (not the session url)", async () => {
    const composio = connector({
      url: "https://composio.session/ephemeral",
      serverName: "com-outlook-mcp",
      composio: { connectorId: "com.microsoft/outlook" },
    });
    const { deps, cap } = buildDeps(
      [{ id: "ws_a", bundles: [composio] }],
      (identity) => (identity === "outlook" ? [lock("outlook", PIN)] : []),
      { byId: catalog({ "com.microsoft/outlook": { composio: { toolkit: "outlook" } } as Partial<ConnectorCatalogEntry> }) },
    );

    await reconcileConnectorSkills(deps);

    expect(cap.syncCalls[0]!.identity).toBe("outlook");
  });

  it("leaves a connector untouched and does not persist when the fetch returns nothing", async () => {
    const stale = connector({ serverName: "com-x-mcp", skillsLock: [lock("x", "v0.2.0")] });
    const { deps, cap } = buildDeps([{ id: "ws_a", bundles: [stale] }], () => []); // 404 / transient

    const result = await reconcileConnectorSkills(deps);

    expect(cap.syncCalls).toHaveLength(1); // attempted
    expect(result.connectorsRefreshed).toBe(0);
    expect(cap.persisted).toHaveLength(0); // never cleared, never persisted
  });

  it("bootReconcileConnectorSkills swallows a failure — never breaks boot", async () => {
    // The boot wrapper's whole job is to be non-fatal: if the reconcile throws
    // (here, the workspace store is down), boot must still proceed.
    const boom: Omit<ConnectorSkillReconcileDeps, "pinnedVersion"> = {
      workDir: "/wd",
      listWorkspaces: async () => {
        throw new Error("workspace store down");
      },
      updateWorkspaceBundles: async () => {},
      syncBoundSkills: async () => [],
      catalogByIdMap: async () => new Map(),
      catalogByUrl: async () => new Map(),
    };
    expect(await bootReconcileConnectorSkills(boom)).toBeUndefined();
  });
});
