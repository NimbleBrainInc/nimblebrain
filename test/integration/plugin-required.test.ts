/**
 * The required reconcile, end to end (ADR-0076, ADR-0077): a runtime booted
 * with a pinned `required` path catalog keeps every one of its items installed
 * in every workspace, a workspace created later included; a person cannot
 * uninstall one, or install one for themselves; an item the catalog drops, or
 * the whole catalog leaving the configuration, is uninstalled everywhere; a
 * catalog turned `available` keeps its items without the mark; a failing item
 * is isolated and retried; a pass with nothing to do changes nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogConfig } from "../../src/config/catalogs.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { PluginsListOutput } from "../../src/platform/schemas/plugins.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { listingBytes, sha256Of } from "../helpers/ai-catalog.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { bareConnectorEntry, type FixtureServer } from "../helpers/plugin-artifacts.ts";

const ADMIN: UserIdentity = {
  id: "usr_required_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

const NOTION: FixtureServer = {
  name: "com.notion/mcp",
  url: "https://mcp.notion.test/mcp",
  meta: { auth: "dcr" },
};
const LINEAR: FixtureServer = {
  name: "app.linear/mcp",
  url: "https://mcp.linear.test/mcp",
  meta: { auth: "dcr" },
};
const NOTION_AT = "notion@acme";
const LINEAR_AT = "linear@acme";
const NOTION_SERVER = "com-notion-mcp";
const LINEAR_SERVER = "app-linear-mcp";

let workDir: string;
let listingPath: string;
let runtime: Runtime | null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-plugin-required-"));
  listingPath = join(workDir, "ai-catalog.json");
  runtime = null;
});

afterEach(async () => {
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

/** Write the listing over `servers` and return the catalog entry that requires it, pinned. */
function requiredListing(
  servers: Record<string, FixtureServer>,
  policy: "required" | "available" = "required",
): CatalogConfig {
  const bytes = listingBytes(Object.entries(servers).map(([n, s]) => bareConnectorEntry(n, s)));
  writeFileSync(listingPath, bytes);
  return { source: listingPath, policy, name: "acme", sha256: sha256Of(bytes) };
}

async function boot(catalogs: CatalogConfig[]): Promise<Runtime> {
  await runtime?.shutdown();
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    catalogs,
  });
  return runtime;
}

async function workspace(rt: Runtime, name: string): Promise<string> {
  const ws = await rt.getWorkspaceStore().create(name, {
    members: [{ userId: ADMIN.id, role: "admin" }],
  });
  return ws.id;
}

function tool(rt: Runtime, wsId: string) {
  const t = createManageConnectorsTool({
    runtime: rt,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => wsId,
  });
  return (input: Record<string, unknown>): Promise<ToolResult> => t.handler(input);
}

async function state(rt: Runtime, wsId: string) {
  const ws = await rt.getWorkspaceStore().get(wsId);
  return {
    records: (ws?.plugins ?? []).map((p) => [p.address, p.required === true]),
    connectors: (ws?.connectors ?? []).map((c) => c.serverName).sort(),
  };
}

const BOTH = { notion: NOTION, linear: LINEAR };

describe("a required catalog", () => {
  test("installs every item into every workspace, one created later included", async () => {
    const first = await boot([]);
    const a = await workspace(first, "A");
    const b = await workspace(first, "B");
    const rt = await boot([requiredListing(BOTH)]);
    const pass = await rt.reconcileRequiredPlugins();
    expect(pass.failed).toEqual([]);
    for (const wsId of [a, b]) {
      expect(await state(rt, wsId)).toEqual({
        records: [
          [NOTION_AT, true],
          [LINEAR_AT, true],
        ],
        connectors: [LINEAR_SERVER, NOTION_SERVER],
      });
    }
    const c = await workspace(rt, "C");
    // Creating it starts a pass for it; the next pass runs after that one.
    await rt.reconcileRequiredPlugins({ wsIds: [] });
    expect((await state(rt, c)).connectors).toEqual([LINEAR_SERVER, NOTION_SERVER]);
  });

  test("a pass with nothing to do changes nothing", async () => {
    const rt = await boot([requiredListing(BOTH)]);
    const wsId = await workspace(rt, "A");
    await rt.reconcileRequiredPlugins();
    const before = await rt.getWorkspaceStore().get(wsId);
    const again = await rt.reconcileRequiredPlugins();
    expect(again).toEqual({ installed: [], updated: [], removed: [], demoted: [], failed: [] });
    // A restart's boot pass is the same no-op.
    const restarted = await boot([requiredListing(BOTH)]);
    expect(await restarted.reconcileRequiredPlugins()).toMatchObject({
      installed: [],
      removed: [],
    });
    expect((await restarted.getWorkspaceStore().get(wsId))?.plugins).toEqual(before?.plugins);
  });

  test("a person cannot uninstall a required item, by address or by its connector", async () => {
    const rt = await boot([requiredListing(BOTH)]);
    const wsId = await workspace(rt, "A");
    await rt.reconcileRequiredPlugins();
    const call = tool(rt, wsId);
    const byAddress = await call({ action: "uninstall", address: NOTION_AT });
    expect(byAddress.isError).toBe(true);
    expect(byAddress.structuredContent).toMatchObject({ error: "REQUIRED" });
    const byServer = await call({ action: "uninstall", serverName: NOTION_SERVER });
    expect(byServer.structuredContent).toMatchObject({ error: "REQUIRED" });
    expect((await state(rt, wsId)).connectors).toContain(NOTION_SERVER);
  });

  test("a person cannot install a required item for themselves", async () => {
    const rt = await boot([requiredListing(BOTH)]);
    const wsId = await workspace(rt, "A");
    const result = await tool(
      rt,
      wsId,
    )({ action: "install", address: NOTION_AT, scope: "identity" });
    expect(result.structuredContent).toMatchObject({ error: "REQUIRED" });
  });

  test("an item that signs in is present, awaiting sign-in, on the plugin list", async () => {
    const rt = await boot([requiredListing(BOTH)]);
    const wsId = await workspace(rt, "A");
    await rt.reconcileRequiredPlugins();
    const listed = (await tool(rt, wsId)({ action: "list_plugins" }))
      .structuredContent as PluginsListOutput;
    const notion = listed.plugins.find((p) => p.servers[0]?.serverName === NOTION_SERVER);
    expect(notion?.servers[0]?.status).toBe("not_connected");
  });

  test("an item dropped from the catalog is uninstalled from every workspace", async () => {
    const first = await boot([requiredListing(BOTH)]);
    const a = await workspace(first, "A");
    const b = await workspace(first, "B");
    await first.reconcileRequiredPlugins();
    const rt = await boot([requiredListing({ notion: NOTION })]);
    const pass = await rt.reconcileRequiredPlugins();
    expect(pass.failed).toEqual([]);
    for (const wsId of [a, b]) {
      expect(await state(rt, wsId)).toEqual({
        records: [[NOTION_AT, true]],
        connectors: [NOTION_SERVER],
      });
    }
  });

  test("a pin that moves an item's digest updates it in every workspace", async () => {
    const first = await boot([requiredListing(BOTH)]);
    const a = await workspace(first, "A");
    await first.reconcileRequiredPlugins();
    const digestOf = async (r: Runtime) =>
      (await r.getWorkspaceStore().get(a))?.plugins?.find((p) => p.address === NOTION_AT)?.digest;
    const before = await digestOf(first);
    const moved = { ...NOTION, url: "https://mcp2.notion.test/mcp" };
    const rt = await boot([requiredListing({ notion: moved, linear: LINEAR })]);
    // The boot pass applies it; a pass after it finds nothing left to do.
    expect((await rt.reconcileRequiredPlugins()).failed).toEqual([]);
    expect(await digestOf(rt)).not.toBe(before);
    const ws = await rt.getWorkspaceStore().get(a);
    expect(ws?.connectors.find((c) => c.serverName === NOTION_SERVER)?.url).toBe(moved.url);
  });

  test("a required catalog removed from the configuration is uninstalled everywhere", async () => {
    const first = await boot([requiredListing(BOTH)]);
    const a = await workspace(first, "A");
    await first.reconcileRequiredPlugins();
    const rt = await boot([]);
    await rt.reconcileRequiredPlugins();
    expect(await state(rt, a)).toEqual({ records: [], connectors: [] });
  });

  test("a catalog turned available keeps its items, no longer required", async () => {
    const first = await boot([requiredListing(BOTH)]);
    const a = await workspace(first, "A");
    await first.reconcileRequiredPlugins();
    const rt = await boot([requiredListing(BOTH, "available")]);
    await rt.reconcileRequiredPlugins();
    expect((await state(rt, a)).records).toEqual([
      [NOTION_AT, false],
      [LINEAR_AT, false],
    ]);
    const removed = await tool(rt, a)({ action: "uninstall", address: NOTION_AT });
    expect(removed.isError).toBe(false);
  });

  test("a failing item is isolated, logged, and installed on a later pass", async () => {
    // Workspaces made before the catalog is required, so nothing is installed yet.
    const first = await boot([]);
    const a = await workspace(first, "A");
    const b = await workspace(first, "B");
    // A connector added by hand under Linear's name: no plugin takes it over.
    await first.getWorkspaceStore().update(a, {
      connectors: [{ url: "https://hand.test/mcp", serverName: LINEAR_SERVER }],
    });
    const rt = await boot([requiredListing(BOTH)]);
    const pass = await rt.reconcileRequiredPlugins();
    expect(pass.failed.map((f) => [f.wsId, f.address])).toEqual([[a, LINEAR_AT]]);
    expect(pass.failed[0]?.error).toContain("added here by hand");
    expect((await state(rt, a)).records).toEqual([[NOTION_AT, true]]);
    expect((await state(rt, b)).connectors).toEqual([LINEAR_SERVER, NOTION_SERVER]);

    expect((await rt.reconcileRequiredPlugins()).failed).toHaveLength(1);
    await tool(rt, a)({ action: "uninstall", serverName: LINEAR_SERVER });
    const healed = await rt.reconcileRequiredPlugins();
    expect(healed.failed).toEqual([]);
    expect(healed.installed).toEqual([{ wsId: a, address: LINEAR_AT }]);
    expect((await state(rt, a)).records).toEqual([
      [NOTION_AT, true],
      [LINEAR_AT, true],
    ]);
  });
});
