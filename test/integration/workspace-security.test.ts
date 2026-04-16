/**
 * Integration tests: Workspace Security
 *
 * Validates workspace-level bundle isolation using per-workspace registries
 * and placement filtering with wsId tags.
 *
 * Covers:
 * - Per-workspace ToolRegistry isolation
 * - filterPlacementsForWorkspace: correct placements per workspace
 * - DevIdentityProvider: workspace gets config bundles populated
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type {
  BriefingBlock,
  BundleRef,
  BundleUiMeta,
  PlacementEntry,
} from "../../src/bundles/types.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { UserStore } from "../../src/identity/user.ts";
import { PlacementRegistry } from "../../src/runtime/placement-registry.ts";
import { filterPlacementsForWorkspace } from "../../src/runtime/workspace-access.ts";
import { ToolRegistry, SharedSourceRef } from "../../src/tools/registry.ts";
import type { Workspace } from "../../src/workspace/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import type { ToolSource, Tool } from "../../src/tools/types.ts";
import type { EngineEvent, EventSink, ToolResult } from "../../src/engine/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nb-sec-integ-"));
}

function makeWorkspace(
  id: string,
  name: string,
  bundles: Workspace["bundles"],
): Workspace {
  return {
    id,
    name,
    members: [],
    bundles,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeSource(name: string, toolNames: string[]): ToolSource {
  const tools: Tool[] = toolNames.map((t) => ({
    name: `${name}__${t}`,
    description: `${t} tool`,
    inputSchema: { type: "object" as const },
    source: `test:${name}`,
  }));
  return {
    name,
    start: async () => {},
    stop: async () => {},
    tools: async () => tools,
    execute: async (toolName: string): Promise<ToolResult> => ({
      content: [{ type: "text", text: `executed ${name}/${toolName}` }],
    }),
  };
}

function placement(serverName: string, slot = "sidebar", wsId?: string): PlacementEntry {
  return {
    serverName,
    slot,
    resourceUri: `ui://${serverName}/main`,
    priority: 100,
    ...(wsId ? { wsId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

// Two workspaces
const wsEng = makeWorkspace("ws_eng", "Engineering", [
  { name: "@nimblebraininc/crm" },
]);

const wsMkt = makeWorkspace("ws_mkt", "Marketing", [
  { name: "@nimblebraininc/dropbox" },
]);

// Sources
const protectedSources = [
  makeSource("conversations", ["list", "get"]),
  makeSource("home", ["briefing"]),
  makeSource("files", ["list"]),
  makeSource("settings", ["get"]),
];

const crmSource = makeSource("crm", ["create_deal", "list_contacts"]);
const dropboxSource = makeSource("dropbox", ["upload", "list_files"]);

// Build per-workspace registries
function buildEngRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const src of protectedSources) {
    reg.addSource(new SharedSourceRef(src));
  }
  reg.addSource(crmSource);
  return reg;
}

function buildMktRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const src of protectedSources) {
    reg.addSource(new SharedSourceRef(src));
  }
  reg.addSource(dropboxSource);
  return reg;
}

// All placements (protected have no wsId, workspace bundles have wsId)
const allPlacements: PlacementEntry[] = [
  ...protectedSources.map((s) => placement(s.name)),
  placement("crm", "sidebar.apps", "ws_eng"),
  placement("dropbox", "sidebar.apps", "ws_mkt"),
];

// ---------------------------------------------------------------------------
// Per-workspace registry isolation
// ---------------------------------------------------------------------------

describe("Workspace security: per-workspace registry isolation", () => {
  test("ws_eng registry has CRM tools but not Dropbox", async () => {
    const reg = buildEngRegistry();
    expect(reg.hasSource("crm")).toBe(true);
    expect(reg.hasSource("dropbox")).toBe(false);
    expect(reg.hasSource("conversations")).toBe(true);
  });

  test("ws_mkt registry has Dropbox tools but not CRM", async () => {
    const reg = buildMktRegistry();
    expect(reg.hasSource("dropbox")).toBe(true);
    expect(reg.hasSource("crm")).toBe(false);
    expect(reg.hasSource("conversations")).toBe(true);
  });

  test("protected sources accessible in both workspace registries", async () => {
    const engReg = buildEngRegistry();
    const mktReg = buildMktRegistry();

    for (const src of protectedSources) {
      expect(engReg.hasSource(src.name)).toBe(true);
      expect(mktReg.hasSource(src.name)).toBe(true);
    }
  });

  test("SharedSourceRef stop does not kill the underlying source", async () => {
    const reg = buildEngRegistry();
    // Remove a protected source from the workspace registry
    await reg.removeSource("conversations");
    // The underlying source should still work
    const tools = await protectedSources[0].tools();
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// filterPlacementsForWorkspace — shell returns correct placements
// ---------------------------------------------------------------------------

describe("Workspace security: filterPlacementsForWorkspace", () => {
  test("ws_eng gets CRM placement + all protected, no Dropbox", () => {
    const result = filterPlacementsForWorkspace(allPlacements, wsEng);
    const names = result.map((p) => p.serverName);

    // Protected placements present (no wsId)
    expect(names).toContain("conversations");
    expect(names).toContain("home");
    expect(names).toContain("files");
    expect(names).toContain("settings");

    // Workspace bundle present
    expect(names).toContain("crm");

    // Other workspace bundle absent
    expect(names).not.toContain("dropbox");
  });

  test("ws_mkt gets Dropbox placement + all protected, no CRM", () => {
    const result = filterPlacementsForWorkspace(allPlacements, wsMkt);
    const names = result.map((p) => p.serverName);

    expect(names).toContain("conversations");
    expect(names).toContain("home");
    expect(names).toContain("files");
    expect(names).toContain("settings");
    expect(names).toContain("dropbox");
    expect(names).not.toContain("crm");
  });

  test("ws_eng placement count = protected count + workspace bundle count", () => {
    const result = filterPlacementsForWorkspace(allPlacements, wsEng);
    expect(result).toHaveLength(5);
  });

  test("ws_mkt placement count = protected count + workspace bundle count", () => {
    const result = filterPlacementsForWorkspace(allPlacements, wsMkt);
    expect(result).toHaveLength(5);
  });

  test("empty workspace only gets protected placements", () => {
    const wsEmpty = makeWorkspace("ws_empty", "Empty", []);
    const result = filterPlacementsForWorkspace(allPlacements, wsEmpty);
    const names = result.map((p) => p.serverName);
    expect(names).toEqual(
      expect.arrayContaining(["conversations", "home", "files", "settings"]),
    );
    expect(names).not.toContain("crm");
    expect(names).not.toContain("dropbox");
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// DevIdentityProvider: workspace has config bundles populated
// ---------------------------------------------------------------------------

describe("Workspace security: DevIdentityProvider populates workspace bundles", () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test("workspace created with empty bundles when provisioned by runtime", async () => {
    workDir = makeTmpDir();

    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    const originalWarn = console.warn;
    console.warn = () => {};

    // DevIdentityProvider no longer creates workspaces — the runtime does.
    // Simulate what the runtime does: create the workspace.
    const adapter = new DevIdentityProvider(workDir, userStore);
    await adapter.verifyRequest(new Request("http://localhost/v1/chat"));

    // Runtime creates the workspace during startup
    const ws = await wsStore.create("Test Workspace", "test");
    await wsStore.addMember(ws.id, "usr_default", "owner");

    console.warn = originalWarn;

    const workspaces = await wsStore.list();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);

    const defaultWs = workspaces[0]!;
    expect(defaultWs.bundles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-workspace data leak regressions (bayze incident, 2026-04)
// ---------------------------------------------------------------------------

describe("Workspace security: same bundle installed in two workspaces", () => {
  const placements = [
    { slot: "sidebar.apps", resourceUri: "ui://crm/nav", priority: 30 },
    { slot: "main", resourceUri: "ui://crm/board", route: "crm" },
  ];

  test("PlacementRegistry: re-registering for a second workspace does not wipe the first", () => {
    const pr = new PlacementRegistry();
    pr.register("crm", placements, "ws_eng");
    pr.register("crm", placements, "ws_mkt");

    const entries = pr.all();
    const eng = entries.filter((e) => e.wsId === "ws_eng");
    const mkt = entries.filter((e) => e.wsId === "ws_mkt");
    expect(eng).toHaveLength(2);
    expect(mkt).toHaveLength(2);
  });

  test("PlacementRegistry: unregister is scoped to the given workspace", () => {
    const pr = new PlacementRegistry();
    pr.register("crm", placements, "ws_eng");
    pr.register("crm", placements, "ws_mkt");

    pr.unregister("crm", "ws_eng");

    const entries = pr.all();
    expect(entries.filter((e) => e.wsId === "ws_eng")).toHaveLength(0);
    expect(entries.filter((e) => e.wsId === "ws_mkt")).toHaveLength(2);
  });

  test("PlacementRegistry: re-registering a global source does not wipe workspace entries", () => {
    const pr = new PlacementRegistry();
    pr.register("crm", placements, "ws_eng");
    pr.register("platform", [placements[0]]); // global, no wsId
    pr.register("platform", [placements[0]]); // re-register global

    expect(pr.all().filter((e) => e.wsId === "ws_eng")).toHaveLength(2);
  });

  test("BundleLifecycleManager: seeding the same bundle in two workspaces keeps them distinct", () => {
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };
    const lifecycle = new BundleLifecycleManager(sink, undefined);

    const ref: BundleRef = { name: "@nimblebraininc/crm" };
    const meta = {
      manifestName: "@nimblebraininc/crm",
      version: "1.0.0",
      ui: { name: "CRM", icon: "cards" } as BundleUiMeta,
      briefing: null as BriefingBlock | null,
      type: "upjack" as const,
      upjackNamespace: "apps/crm",
    };

    lifecycle.seedInstance("crm", "@nimblebraininc/crm", ref, meta, "ws_eng", "/data/ws_eng/data/crm");
    lifecycle.seedInstance("crm", "@nimblebraininc/crm", ref, meta, "ws_mkt", "/data/ws_mkt/data/crm");

    const eng = lifecycle.getInstance("crm", "ws_eng");
    const mkt = lifecycle.getInstance("crm", "ws_mkt");

    expect(eng?.wsId).toBe("ws_eng");
    expect(mkt?.wsId).toBe("ws_mkt");
    expect(eng?.entityDataRoot).toContain("ws_eng");
    expect(mkt?.entityDataRoot).toContain("ws_mkt");
    // Distinct objects — one workspace's data root must not be the other's
    expect(eng?.entityDataRoot).not.toBe(mkt?.entityDataRoot);
    // The unscoped snapshot exposes both — the bug was that a serverName-only
    // filter would return both when asked for one workspace's instances.
    expect(lifecycle.getInstances()).toHaveLength(2);
  });
});
