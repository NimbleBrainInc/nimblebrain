/**
 * `manage_connectors` `list_plugins` (ADR-0068, ADR-0069): the workspace's
 * connectors and the caller's personal ones, as plugins that each say whose
 * they are, whether they act here, and the account each server is signed in as.
 *
 * `projectPlugins` is tested on its own for the shape; the handler is tested
 * through the tool over a stubbed runtime, so the facts come from the same
 * reads `list_installed` and `list_personal_connectors` make.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { noCatalogListings } from "../../src/catalogs/reader.ts";
import type { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import type { ManagedConnectorRegistry } from "../../src/connectors/providers/registry.ts";
import type { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type {
  ConnectorInstance,
  ConnectorUiMeta,
  PlacementEntry,
} from "../../src/connectors/runtime/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { UserStore } from "../../src/identity/user.ts";
import { ADMIT_ALL } from "../../src/permissions/admin-tools.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import { PluginsListOutput } from "../../src/platform/schemas/plugins.ts";
import type { InstalledPluginRecord } from "../../src/plugins/installed/record.ts";
import { createPluginRecordStore } from "../../src/plugins/installed/record.ts";
import { PlacementRegistry } from "../../src/runtime/placement-registry.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { ConnectorOverlayInfo } from "../../src/skills/connector-skill-store.ts";
import type { PublishedSkillInfo } from "../../src/skills/connector-skills.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { requireCredentialStore } from "../../src/tools/credential-store.ts";
import { McpOAuthRecords } from "../../src/tools/mcp-oauth-records.ts";
import { type PluginListingFacts, projectPlugins } from "../../src/tools/plugin-listing.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { stub } from "../helpers/stub.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS = "ws_003eba8844413cd9";
const OTHER_WS = "ws_0015146e7514bc0c";
const ALICE = "usr_alice";
const CALLER = stub<UserIdentity>({ id: ALICE, email: "alice@example.com", displayName: "Alice" });

const validateOutput = new Ajv({ strict: false }).compile(PluginsListOutput);

function expectValid(output: unknown): void {
  const ok = validateOutput(output);
  if (!ok) throw new Error(JSON.stringify(validateOutput.errors));
}

function facts(overrides: Partial<PluginListingFacts> = {}): PluginListingFacts {
  return {
    wsId: WS,
    workspace: [],
    personal: [],
    overlays: [],
    published: [],
    placements: [],
    ...overrides,
  };
}

function placement(p: Partial<PlacementEntry> & { serverName: string }): PlacementEntry {
  return {
    slot: "sidebar.apps",
    resourceUri: `ui://${p.serverName}/main`,
    priority: 100,
    wsId: WS,
    ...p,
  };
}

describe("projectPlugins", () => {
  function record(address: string, names: string[]): InstalledPluginRecord {
    return {
      address,
      digest: `sha256:${"a".repeat(64)}`,
      type: "application/agent-plugins+zip",
      installedAt: "2026-11-27T00:00:00.000Z",
      connectors: names.map((name) => ({
        key: name,
        name,
        server: { name, version: "1.0.0", description: name },
      })),
      skills: [],
      starters: [],
    };
  }
  const ready = (serverName: string) => ({
    serverName,
    displayName: serverName,
    status: "ready" as const,
  });

  test("a record is one plugin with every connection it lists; one no record names is its own", () => {
    const out = projectPlugins(
      facts({
        workspace: [ready("com-a-mcp"), ready("com-b-mcp"), ready("hand-added")],
        workspaceRecords: [record("suite@test", ["com.a/mcp", "com.b/mcp", "com.c/mcp"])],
        displays: new Map([["suite@test", { displayName: "Suite", description: "Both" }]]),
        overlays: [{ server: "com-b-mcp", name: "guide" }],
      }),
    );
    expectValid(out);
    expect(
      out.plugins.map((p) => [p.id, p.displayName, p.servers.map((s) => s.serverName)]),
    ).toEqual([
      ["workspace:plugin:suite@test", "Suite", ["com-a-mcp", "com-b-mcp"]],
      ["workspace:hand-added", "hand-added", ["hand-added"]],
    ]);
    expect(out.plugins[0]?.skills).toEqual([
      { name: "guide", kind: "overlay", serverName: "com-b-mcp" },
    ]);
  });

  test("a one-connection record shows as its connection, and a record with none here is left out", () => {
    const out = projectPlugins(
      facts({
        workspace: [ready("com-notion-mcp")],
        workspaceRecords: [
          record("notion@test", ["com.notion/mcp"]),
          record("gone@test", ["x.y/z"]),
        ],
        displays: new Map([["notion@test", { displayName: "Notion plugin" }]]),
      }),
    );
    expect(out.plugins.map((p) => [p.id, p.displayName])).toEqual([
      ["workspace:plugin:notion@test", "com-notion-mcp"],
    ]);
  });

  test("a workspace connector is a workspace plugin with one server, granted", () => {
    const out = projectPlugins(
      facts({
        workspace: [
          {
            serverName: "linear",
            displayName: "Linear",
            iconUrl: "https://example.com/linear.svg",
            status: "ready",
            identity: { email: "team@example.com", name: "Team" },
          },
        ],
      }),
    );
    expectValid(out);
    expect(out.wsId).toBe(WS);
    expect(out.plugins).toEqual([
      {
        id: "workspace:linear",
        displayName: "Linear",
        iconUrl: "https://example.com/linear.svg",
        owner: { kind: "workspace" },
        granted: true,
        servers: [
          {
            serverName: "linear",
            status: "ready",
            account: { email: "team@example.com", name: "Team" },
          },
        ],
        skills: [],
        apps: [],
      },
    ]);
  });

  test("a personal connector is a person's plugin, granted only where its owner granted it", () => {
    const out = projectPlugins(
      facts({
        personal: [
          {
            serverName: "granola",
            displayName: "Granola",
            status: "ready",
            grantedWorkspaces: [WS],
          },
          {
            serverName: "notion",
            displayName: "Notion",
            status: "not_connected",
            statusReason: "Connect to use this connector.",
            grantedWorkspaces: [OTHER_WS],
          },
        ],
      }),
    );
    expectValid(out);
    const [granola, notion] = out.plugins;
    expect(granola?.owner).toEqual({ kind: "person" });
    expect(granola?.granted).toBe(true);
    expect(notion?.owner).toEqual({ kind: "person" });
    expect(notion?.granted).toBe(false);
    expect(notion?.servers).toEqual([
      {
        serverName: "notion",
        status: "not_connected",
        statusReason: "Connect to use this connector.",
        account: null,
      },
    ]);
  });

  test("a plugin carries its connector's description, and none when it has none", () => {
    const out = projectPlugins(
      facts({
        workspace: [
          {
            serverName: "linear",
            displayName: "Linear",
            description: "Issues and projects",
            status: "ready",
          },
          { serverName: "crm", displayName: "CRM", description: null, status: "ready" },
        ],
        personal: [
          {
            serverName: "granola",
            displayName: "Granola",
            description: "Meeting notes",
            status: "ready",
            grantedWorkspaces: [],
          },
        ],
      }),
    );
    expectValid(out);
    expect(out.plugins.map((p) => p.description)).toEqual([
      "Issues and projects",
      undefined,
      "Meeting notes",
    ]);
    expect(out.plugins[1]).not.toHaveProperty("description");
  });

  test("the same server installed for the workspace and the person is two plugins", () => {
    const out = projectPlugins(
      facts({
        workspace: [{ serverName: "gmail", displayName: "Gmail", status: "ready" }],
        personal: [
          { serverName: "gmail", displayName: "Gmail", status: "ready", grantedWorkspaces: [] },
        ],
        overlays: [{ server: "gmail", name: "usage" }],
        placements: [placement({ serverName: "gmail" })],
      }),
    );
    expectValid(out);
    expect(out.plugins.map((p) => p.id)).toEqual(["workspace:gmail", "person:gmail"]);
    // Skills and views are the workspace connector's; the personal one's are not composed here.
    expect(out.plugins[0]?.skills).toHaveLength(1);
    expect(out.plugins[0]?.apps).toHaveLength(1);
    expect(out.plugins[1]?.skills).toEqual([]);
    expect(out.plugins[1]?.apps).toEqual([]);
  });

  test("a granted personal plugin lists the views its server places, with no route", () => {
    const report = {
      slot: "sidebar.apps",
      resourceUri: "ui://bassethound/report",
      label: "Report",
    };
    const out = projectPlugins(
      facts({
        personal: [
          {
            serverName: "bassethound",
            displayName: "Bassethound",
            status: "ready",
            grantedWorkspaces: [WS],
            placements: [report, { slot: "sidebar.bottom", resourceUri: "ui://bassethound/tray" }],
          },
          {
            serverName: "granola",
            displayName: "Granola",
            status: "ready",
            grantedWorkspaces: [OTHER_WS],
            placements: [{ slot: "sidebar.apps", resourceUri: "ui://granola/notes" }],
          },
        ],
        // A workspace placement of the same server is the workspace's, not the person's.
        placements: [placement({ serverName: "bassethound" })],
      }),
    );
    expectValid(out);
    const [bassethound, granola] = out.plugins;
    expect(bassethound?.apps).toEqual([
      { label: "Report", serverName: "bassethound", resourceUri: "ui://bassethound/report" },
    ]);
    // Not granted here: its views cannot render here, so none are listed.
    expect(granola?.apps).toEqual([]);
  });

  test("a plugin carries its bound skills and the views its server places among the apps", () => {
    const out = projectPlugins(
      facts({
        workspace: [
          { serverName: "crm", displayName: "CRM", status: "ready" },
          { serverName: "other", displayName: "Other", status: "ready" },
        ],
        overlays: [{ server: "crm", name: "crm-usage", description: "How to use the CRM" }],
        published: [
          { server: "crm", name: "pipeline", description: "Run the pipeline" },
          { server: "other", name: "not-mine", description: "x" },
        ],
        placements: [
          placement({
            serverName: "crm",
            label: "Companies",
            route: "crm/companies",
            priority: 20,
          }),
          placement({ serverName: "crm", label: "Deals", route: "crm/deals", priority: 10 }),
          // Not apps: core nav, the utility tray, another workspace, another server.
          placement({ serverName: "crm", slot: "sidebar", label: "Nav" }),
          placement({ serverName: "crm", slot: "sidebar.bottom", label: "Tray" }),
          placement({ serverName: "crm", wsId: OTHER_WS, label: "Elsewhere" }),
          placement({ serverName: "other", label: "Other" }),
          // No label: falls back to the plugin's name.
          placement({ serverName: "crm", resourceUri: "ui://crm/home", priority: 30 }),
        ],
      }),
    );
    expectValid(out);
    const crm = out.plugins.find((p) => p.id === "workspace:crm");
    expect(crm?.skills).toEqual([
      { name: "crm-usage", description: "How to use the CRM", kind: "overlay", serverName: "crm" },
      { name: "pipeline", description: "Run the pipeline", kind: "published", serverName: "crm" },
    ]);
    expect(crm?.apps).toEqual([
      { label: "Deals", serverName: "crm", resourceUri: "ui://crm/main", route: "crm/deals" },
      {
        label: "Companies",
        serverName: "crm",
        resourceUri: "ui://crm/main",
        route: "crm/companies",
      },
      { label: "CRM", serverName: "crm", resourceUri: "ui://crm/home" },
    ]);
  });

  test("account is the identity's display fields only, and null without one", () => {
    const out = projectPlugins(
      facts({
        workspace: [
          {
            serverName: "a",
            displayName: "A",
            status: "ready",
            // A record carrying more than the display fields passes none of the rest.
            identity: { email: "a@example.com", sub: "vendor-subject" } as { email: string },
          },
          { serverName: "b", displayName: "B", status: "ready", identity: { name: "Bea" } },
          { serverName: "c", displayName: "C", status: "ready", identity: {} },
          { serverName: "d", displayName: "D", status: "ready" },
        ],
      }),
    );
    expectValid(out);
    expect(out.plugins.map((p) => p.servers[0]?.account)).toEqual([
      { email: "a@example.com" },
      { name: "Bea" },
      null,
      null,
    ]);
  });
});

// ── Through the tool ────────────────────────────────────────────────

interface Harness {
  workDir: string;
  tool: ReturnType<typeof createManageConnectorsTool>;
}

async function buildHarness(opts: {
  workspaceConnectors: string[];
  personalConnectors: string[];
  grants?: Record<string, string>;
  overlays?: ConnectorOverlayInfo[];
  published?: PublishedSkillInfo[];
  placements?: Array<{ serverName: string; label: string; route: string }>;
  /** The host UI a personal connector's install stored, by server name. */
  personalUi?: Record<string, ConnectorUiMeta>;
}): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-plugin-listing-"));
  installTestCredentialStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  await seedWorkspace(workspaceStore, WS, {
    name: "Helix",
    members: [{ userId: ALICE, role: "admin" }],
  });
  const permissions = new PermissionStore(workDir);
  const identityStore = new IdentityConnectorStore({ workDir });
  for (const serverName of opts.personalConnectors) {
    await identityStore.add(ALICE, {
      url: `https://mcp.example.com/${serverName}`,
      serverName,
      ui: opts.personalUi?.[serverName] ?? null,
    });
  }
  for (const [serverName, wsId] of Object.entries(opts.grants ?? {})) {
    await permissions.grantConnector(ALICE, serverName, wsId);
  }
  const instances = opts.workspaceConnectors.map((serverName) =>
    stub<ConnectorInstance>({
      serverName,
      connectorName: serverName,
      version: "1.0.0",
      state: "running",
      ui: null,
      wsId: WS,
      ref: { url: `https://mcp.example.com/${serverName}`, serverName },
    }),
  );
  const placements = new PlacementRegistry();
  for (const p of opts.placements ?? []) {
    placements.register(
      p.serverName,
      [
        {
          slot: "sidebar.apps",
          resourceUri: `ui://${p.serverName}/main`,
          label: p.label,
          route: p.route,
        },
      ],
      WS,
    );
  }
  const catalog: ConnectorCatalogEntry[] = [];
  const runtime = stub<Runtime>({
    getWorkDir: () => workDir,
    getCredentialStore: () => requireCredentialStore(),
    getWorkspaceStore: () => workspaceStore,
    getPermissionStore: () => permissions,
    getUserStore: () => stub<UserStore>({ get: async () => null }),
    getManagedConnectorRegistry: () => stub<ManagedConnectorRegistry>({ get: () => undefined }),
    getConnectorCatalog: () =>
      stub<ConnectorCatalog>({
        catalogEntries: async () => catalog,
        catalogByUrl: async () => new Map(),
        catalogByIdMap: async () => new Map(),
      }),
    getLifecycle: () =>
      stub<ConnectorLifecycleManager>({
        getInstances: () => instances,
        isDisconnectable: () => true,
        isIdentityConnectorRunning: () => false,
        lookUpAccount: async () => null,
      }),
    getRegistryForWorkspace: () => stub<ToolRegistry>({ getSource: () => undefined }),
    connectorAdmission: async () => ADMIT_ALL,
    listConnectorOverlays: () => opts.overlays ?? [],
    listPublishedSkills: async () => opts.published ?? [],
    getPlacementRegistry: () => placements,
    getPluginRecords: () => createPluginRecordStore({ workspaces: workspaceStore, workDir }),
    getCatalogListings: () => noCatalogListings(),
  });
  const tool = createManageConnectorsTool({
    runtime,
    getIdentity: () => CALLER,
    getWorkspaceId: () => WS,
  });
  return { workDir, tool };
}

function listing(result: { structuredContent?: unknown; isError?: boolean }): PluginsListOutput {
  expect(result.isError).toBeFalsy();
  expectValid(result.structuredContent);
  return result.structuredContent as PluginsListOutput;
}

describe("manage_connectors list_plugins", () => {
  let h: Harness | undefined;
  afterEach(() => {
    resetTestCredentialStore();
    if (h) rmSync(h.workDir, { recursive: true, force: true });
    h = undefined;
  });

  test("lists workspace and personal plugins with owner, grant, account, skills and apps", async () => {
    h = await buildHarness({
      workspaceConnectors: ["linear", "stripe"],
      personalConnectors: ["granola", "notion"],
      grants: { granola: WS, notion: OTHER_WS },
      overlays: [
        {
          server: "linear",
          name: "linear-usage",
          description: "Working with Linear",
          toolAffinity: ["linear__*"],
          path: "/dev/null",
        },
      ],
      placements: [{ serverName: "linear", label: "Issues", route: "linear/issues" }],
    });
    // Linear's workspace connection recorded who signed in; Stripe's (API key) none.
    await new McpOAuthRecords({
      owner: { type: "workspace", wsId: WS },
      serverName: "linear",
    }).write("identity", { sub: "vendor-subject", email: "ops@example.com", name: "Ops" });
    // Granola is connected and recorded its account; Notion is not connected.
    const alice = { type: "user", userId: ALICE } as const;
    await new McpOAuthRecords({ owner: alice, serverName: "granola" }).write("tokens", {
      access_token: "at",
      token_type: "Bearer",
    });
    await new McpOAuthRecords({ owner: alice, serverName: "granola" }).write("identity", {
      email: "alice@vendor.example",
    });

    const out = listing(await h.tool.handler({ action: "list_plugins" }));
    const byId = new Map(out.plugins.map((p) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual([
      "person:granola",
      "person:notion",
      "workspace:linear",
      "workspace:stripe",
    ]);

    const linear = byId.get("workspace:linear");
    expect(linear?.owner).toEqual({ kind: "workspace" });
    expect(linear?.granted).toBe(true);
    expect(linear?.servers).toEqual([
      { serverName: "linear", status: "ready", account: { email: "ops@example.com", name: "Ops" } },
    ]);
    expect(linear?.skills).toEqual([
      {
        name: "linear-usage",
        description: "Working with Linear",
        kind: "overlay",
        serverName: "linear",
      },
    ]);
    expect(linear?.apps).toEqual([
      {
        label: "Issues",
        serverName: "linear",
        resourceUri: "ui://linear/main",
        route: "linear/issues",
      },
    ]);
    expect(byId.get("workspace:stripe")?.servers[0]?.account).toBeNull();

    const granola = byId.get("person:granola");
    expect(granola?.owner).toEqual({ kind: "person" });
    expect(granola?.granted).toBe(true);
    expect(granola?.servers).toEqual([
      { serverName: "granola", status: "ready", account: { email: "alice@vendor.example" } },
    ]);

    const notion = byId.get("person:notion");
    expect(notion?.granted).toBe(false);
    expect(notion?.servers[0]?.status).toBe("not_connected");
    expect(notion?.servers[0]?.account).toBeNull();

    // Nothing from the token records reaches the listing.
    expect(JSON.stringify(out)).not.toContain("Bearer");
    expect(JSON.stringify(out)).not.toContain("vendor-subject");
  });

  test("a granted personal plugin's apps are the views its install places", async () => {
    const ui: ConnectorUiMeta = {
      placements: [
        { slot: "sidebar.apps", resourceUri: "ui://bassethound/report", label: "Report" },
      ],
    };
    h = await buildHarness({
      workspaceConnectors: [],
      personalConnectors: ["bassethound", "granola"],
      grants: { bassethound: WS, granola: OTHER_WS },
      personalUi: { bassethound: ui, granola: ui },
    });
    const out = listing(await h.tool.handler({ action: "list_plugins" }));
    const byId = new Map(out.plugins.map((p) => [p.id, p]));
    expect(byId.get("person:bassethound")?.apps).toEqual([
      { label: "Report", serverName: "bassethound", resourceUri: "ui://bassethound/report" },
    ]);
    expect(byId.get("person:granola")?.apps).toEqual([]);
  });

  test("is refused without a workspace", async () => {
    h = await buildHarness({ workspaceConnectors: [], personalConnectors: [] });
    const tool = createManageConnectorsTool({
      runtime: stub<Runtime>({}),
      getIdentity: () => CALLER,
      getWorkspaceId: () => null,
    });
    const res = await tool.handler({ action: "list_plugins" });
    expect(res.isError).toBe(true);
  });
});
