import { describe, expect, it } from "bun:test";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import {
  bootReconcileConnectorSkills,
  type ConnectorSkillReconcileDeps,
  reconcileConnectorSkills,
} from "../../../src/connectors/runtime/connector-skill-reconcile.ts";
import type {
  BrokeredRef,
  ConnectorRef,
  ConnectorSkillLockEntry,
} from "../../../src/connectors/runtime/types.ts";
import { stub } from "../../helpers/stub.ts";

const PIN = "c".repeat(64);
const OLD_PIN = "b".repeat(64);

/** A lock written from the catalog: it records the server's registry name. */
function lock(server: string, version: string): ConnectorSkillLockEntry {
  return {
    plugin: `${server.split("/")[0]}@nimblebrain`,
    server,
    skill: "usage",
    version,
    digest: "d".repeat(64),
    sha: `sha-${version}`,
  };
}

/** A lock written while skills came from the connector-skills repo. */
function legacyLock(identity: string): ConnectorSkillLockEntry {
  const onDisk = { identity, version: "v0.5.0", sha: "sha-legacy" };
  return onDisk;
}

function connector(fields: {
  url?: string;
  serverName: string;
  skillsLock?: ConnectorSkillLockEntry[];
  composio?: { connectorId: string };
  brokered?: BrokeredRef;
}): ConnectorRef {
  return {
    url: fields.url ?? "https://example.test/mcp",
    serverName: fields.serverName,
    ...(fields.skillsLock ? { skillsLock: fields.skillsLock } : {}),
    ...(fields.composio ? { composio: fields.composio } : {}),
    ...(fields.brokered ? { brokered: fields.brokered } : {}),
  };
}

function catalog(
  entries: Record<string, Partial<ConnectorCatalogEntry>>,
): Map<string, ConnectorCatalogEntry> {
  return new Map(
    Object.entries(entries).map(([key, entry]) => [key, stub<ConnectorCatalogEntry>(entry)]),
  );
}

interface Captured {
  syncCalls: Array<{ server: string; serverName: string; wsId: string }>;
  persisted: Array<{ wsId: string; connectors: ConnectorRef[] }>;
}

function buildDeps(
  workspaces: Array<{ id: string; connectors: ConnectorRef[] }>,
  syncImpl: (server: string, serverName: string) => ConnectorSkillLockEntry[],
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
    updateWorkspaceConnectors: async (wsId, connectors) => {
      cap.persisted.push({ wsId, connectors });
    },
    syncBoundSkills: async (server, serverName, wsId) => {
      cap.syncCalls.push({ server, serverName, wsId });
      return syncImpl(server, serverName);
    },
    catalogByIdMap: async () => opts.byId ?? new Map(),
    catalogByUrl: async () => opts.byUrl ?? new Map(),
  };
  return { deps, cap };
}

function skillsLockOf(ref: ConnectorRef): ConnectorSkillLockEntry[] | undefined {
  return "skillsLock" in ref ? ref.skillsLock : undefined;
}

describe("reconcileConnectorSkills", () => {
  it("refreshes a stale connector, skips one at the pin, passes non-connectors through", async () => {
    const stale = connector({
      serverName: "com-outlook-mcp",
      skillsLock: [lock("com.microsoft/outlook", OLD_PIN)],
    });
    const current = connector({
      serverName: "com-gmail-mcp",
      skillsLock: [lock("com.google/gmail", PIN)],
    });
    // biome-ignore lint/plugin/double-cast: a pre-URL registry row as it sits on disk, claimed as a ConnectorRef, which does not admit it
    const registry = { name: "@nimblebraininc/synapse-crm" } as unknown as ConnectorRef;
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [stale, current, registry] }],
      (server) => [lock(server, PIN)],
    );

    const result = await reconcileConnectorSkills(deps);

    // Only the stale connector synced — reusing the server its lock records.
    expect(cap.syncCalls).toEqual([
      {
        server: "com.microsoft/outlook",
        serverName: "com-outlook-mcp",
        wsId: "ws_00079598e311c160",
      },
    ]);
    expect(result).toEqual({ workspacesScanned: 1, connectorsRefreshed: 1 });
    expect(cap.persisted).toHaveLength(1);

    const persisted = cap.persisted[0]!.connectors;
    const updatedStale = persisted.find(
      (b) => "serverName" in b && b.serverName === "com-outlook-mcp",
    );
    expect(skillsLockOf(updatedStale!)?.[0]?.version).toBe(PIN);
    // Untouched entries survive verbatim.
    expect(persisted.some((b) => "name" in b && b.name === "@nimblebraininc/synapse-crm")).toBe(
      true,
    );
  });

  it("skips a named connector whose url is not http(s), and still refreshes a valid one", async () => {
    const unusable = connector({
      url: "file:///etc/mcp",
      serverName: "com-broken-mcp",
      skillsLock: [lock("com.broken/mcp", OLD_PIN)],
    });
    const valid = connector({
      serverName: "com-outlook-mcp",
      skillsLock: [lock("com.microsoft/outlook", OLD_PIN)],
    });
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [unusable, valid] }],
      (server) => [lock(server, PIN)],
    );

    const result = await reconcileConnectorSkills(deps);

    expect(cap.syncCalls).toEqual([
      {
        server: "com.microsoft/outlook",
        serverName: "com-outlook-mcp",
        wsId: "ws_00079598e311c160",
      },
    ]);
    expect(result.connectorsRefreshed).toBe(1);
    const persisted = cap.persisted[0]!.connectors;
    expect(persisted[0]).toBe(unusable);
    expect(skillsLockOf(persisted[1]!)?.[0]?.version).toBe(PIN);
  });

  it("is a no-op (no sync, no persist) when every connector is already at the pin", async () => {
    const current = connector({
      serverName: "com-gmail-mcp",
      skillsLock: [lock("com.google/gmail", PIN)],
    });
    const { deps, cap } = buildDeps([{ id: "ws_00079598e311c160", connectors: [current] }], () => [
      lock("com.google/gmail", PIN),
    ]);

    const result = await reconcileConnectorSkills(deps);

    expect(cap.syncCalls).toHaveLength(0);
    expect(cap.persisted).toHaveLength(0);
    expect(result).toEqual({ workspacesScanned: 1, connectorsRefreshed: 0 });
  });

  it("first-binds a DCR connector (no lock) by the registry name the catalog gives its url", async () => {
    const dcr = connector({ url: "https://api.dropbox.test/mcp", serverName: "com-dropbox-mcp" });
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [dcr] }],
      (server) => (server === "com.dropbox/mcp" ? [lock(server, PIN)] : []),
      { byUrl: catalog({ "https://api.dropbox.test/mcp": { id: "com.dropbox/mcp" } }) },
    );

    const result = await reconcileConnectorSkills(deps);

    // The registry name, NOT the slug com-dropbox-mcp.
    expect(cap.syncCalls[0]!.server).toBe("com.dropbox/mcp");
    expect(result.connectorsRefreshed).toBe(1);
    expect(skillsLockOf(cap.persisted[0]!.connectors[0]!)?.[0]?.server).toBe("com.dropbox/mcp");
  });

  it("moves a connector-skills lock onto the catalog: re-resolves its server and replaces the lock", async () => {
    // A lock from the connector-skills repo records a derived identity and a git
    // tag, never a registry name or a catalog pin. The tag never equals the pin,
    // so boot re-binds it, finding the registry name through the catalog.
    const old = connector({
      url: "https://api.dropbox.test/mcp",
      serverName: "com-dropbox-mcp",
      skillsLock: [legacyLock("dropbox")],
    });
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [old] }],
      (server) => [lock(server, PIN)],
      { byUrl: catalog({ "https://api.dropbox.test/mcp": { id: "com.dropbox/mcp" } }) },
    );

    const result = await reconcileConnectorSkills(deps);

    expect(cap.syncCalls[0]!.server).toBe("com.dropbox/mcp");
    expect(result.connectorsRefreshed).toBe(1);
    expect(skillsLockOf(cap.persisted[0]!.connectors[0]!)).toEqual([lock("com.dropbox/mcp", PIN)]);
  });

  it("keeps a connector-skills lock the catalog has no plugin skill for", async () => {
    const old = connector({
      url: "https://api.gone.test/mcp",
      serverName: "com-gone-mcp",
      skillsLock: [legacyLock("gone")],
    });
    const { deps, cap } = buildDeps([{ id: "ws_00079598e311c160", connectors: [old] }], () => [], {
      byUrl: catalog({ "https://api.gone.test/mcp": { id: "com.gone/mcp" } }),
    });

    await reconcileConnectorSkills(deps);

    expect(cap.syncCalls[0]!.server).toBe("com.gone/mcp");
    expect(cap.persisted).toHaveLength(0);
  });

  it("does not bind a connector the catalog does not list", async () => {
    const unlisted = connector({ url: "https://elsewhere.test/mcp", serverName: "x" });
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [unlisted] }],
      () => [],
    );

    await reconcileConnectorSkills(deps);

    expect(cap.syncCalls).toHaveLength(0);
  });

  it("first-binds a composio connector by its catalog id (not the session url)", async () => {
    const composio = connector({
      url: "https://composio.session/ephemeral",
      serverName: "com-outlook-mcp",
      brokered: { provider: "composio", connectorId: "com.microsoft/outlook" },
    });
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [composio] }],
      (server) => (server === "com.microsoft/outlook" ? [lock(server, PIN)] : []),
      { byId: catalog({ "com.microsoft/outlook": { id: "com.microsoft/outlook" } }) },
    );

    await reconcileConnectorSkills(deps);

    expect(cap.syncCalls[0]!.server).toBe("com.microsoft/outlook");
  });

  it("first-binds a smithery connector from the catalog id, not the session url", async () => {
    // Smithery's persisted url is a per-install broker session, so byUrl misses
    // and the stamped catalog id is the only route back to the registry name.
    const smithery = connector({
      url: "https://api.smithery.ai/connect/ns/nb-abc/mcp",
      serverName: "ai-bassethound-mcp",
      brokered: {
        provider: "smithery",
        connectorId: "ai.bassethound/mcp",
        providerRef: {
          connectionId: "nb-abc",
          namespace: "ns",
          baseUrl: "https://api.smithery.ai",
        },
      },
    });
    const { deps, cap } = buildDeps(
      [{ id: "ws_00079598e311c160", connectors: [smithery] }],
      (server) => (server === "ai.bassethound/mcp" ? [lock(server, PIN)] : []),
      { byId: catalog({ "ai.bassethound/mcp": { id: "ai.bassethound/mcp" } }) },
    );

    await reconcileConnectorSkills(deps);

    expect(cap.syncCalls[0]!.server).toBe("ai.bassethound/mcp");
  });

  it("leaves a connector untouched and does not persist when the fetch returns nothing", async () => {
    const stale = connector({ serverName: "com-x-mcp", skillsLock: [lock("com.x/mcp", OLD_PIN)] });
    const { deps, cap } = buildDeps([{ id: "ws_00079598e311c160", connectors: [stale] }], () => []); // 404 / transient

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
      updateWorkspaceConnectors: async () => {},
      syncBoundSkills: async () => [],
      catalogByIdMap: async () => new Map(),
      catalogByUrl: async () => new Map(),
    };
    expect(await bootReconcileConnectorSkills(boom)).toBeUndefined();
  });
});
