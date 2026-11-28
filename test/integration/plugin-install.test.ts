/**
 * Installing catalog items as plugins, end to end (ADR-0077): a runtime booted
 * with a path catalog whose entries point at artifacts a local server holds.
 * Install fetches and verifies each artifact once, connects its servers through
 * the connector install path, materializes its skills as managed skills and
 * writes the installed-plugin record; uninstall and update act on exactly what
 * the record lists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { PluginsListOutput } from "../../src/platform/schemas/plugins.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { McpOAuthRecords } from "../../src/tools/mcp-oauth-records.ts";
import { listingBytes } from "../helpers/ai-catalog.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import {
  artifactEntry,
  bareConnectorEntry,
  type FixtureServer,
  pluginZip,
  skillMd,
} from "../helpers/plugin-artifacts.ts";

const ADMIN: UserIdentity = {
  id: "usr_plugin_admin",
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
const NOTION_SERVER = "com-notion-mcp";
const LINEAR_SERVER = "app-linear-mcp";

let workDir: string;
let listingPath: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let objects: Map<string, Uint8Array>;
let requests: string[];
let runtime: Runtime | null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-plugin-install-"));
  listingPath = join(workDir, "ai-catalog.json");
  objects = new Map();
  requests = [];
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = objects.get(path);
      return body ? new Response(body) : new Response("", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  runtime = null;
});

afterEach(async () => {
  await runtime?.shutdown();
  await server.stop(true);
  rmSync(workDir, { recursive: true, force: true });
});

/** Serve `bytes` and return its listing entry. */
function publish(
  name: string,
  bytes: Uint8Array,
  over: {
    type?: string;
    digest?: string;
    servers?: Record<string, { name: string; auth: string }>;
  } = {},
): Record<string, unknown> {
  const { entry, path } = artifactEntry({ name, bytes, base, ...over });
  objects.set(path, bytes);
  return entry;
}

function writeListing(entries: unknown[]): void {
  writeFileSync(listingPath, listingBytes(entries));
}

async function boot(
  catalogs: Array<{ source: string; policy: "available"; name: string }> = [
    { source: listingPath, policy: "available", name: "test" },
  ],
): Promise<{
  rt: Runtime;
  wsId: string;
  call: (input: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const rt = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    catalogs,
  });
  runtime = rt;
  const ws = await rt.getWorkspaceStore().create("Plugins", {
    members: [{ userId: ADMIN.id, role: "admin" }],
  });
  await rt.ensureWorkspaceRegistry(ws.id);
  const tool = createManageConnectorsTool({
    runtime: rt,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => ws.id,
  });
  return { rt, wsId: ws.id, call: (input) => tool.handler(input) };
}

async function workspace(rt: Runtime, wsId: string) {
  const ws = await rt.getWorkspaceStore().get(wsId);
  if (!ws) throw new Error("no workspace");
  return ws;
}

function artifactFetches(): string[] {
  return requests.filter((p) => p.startsWith("/artifacts/"));
}

const notionPlugin = (title = "Notion") =>
  pluginZip({
    name: "notion",
    servers: { notion: { ...NOTION, meta: { auth: "dcr" } } },
    skills: {
      notion: skillMd("notion", { server: "notion", body: `${title} guidance.` }),
      writing: skillMd("writing", { body: "Write well." }),
    },
    starters: [{ title: "Find a page", text: "Help me find a Notion page." }],
  });

describe("plugin install", () => {
  test("install, then uninstall: one fetch, a record of what it produced, all of it removed", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, wsId, call } = await boot();

    const installed = await call({ action: "install", entry: { address: "notion@test" } });
    expect(installed.isError).toBe(false);
    expect(installed.structuredContent).toMatchObject({
      ok: true,
      address: "notion@test",
      serverName: NOTION_SERVER,
      serverNames: [NOTION_SERVER],
      scope: "workspace",
      wsId,
    });
    expect(artifactFetches()).toHaveLength(1);

    const ws = await workspace(rt, wsId);
    expect(ws.connectors.map((c) => c.serverName)).toEqual([NOTION_SERVER]);
    // A plugin's skills come from its artifact, never the zip-scanning resolver.
    expect(ws.connectors[0]?.skillsLock).toBeUndefined();
    const record = ws.plugins?.[0];
    expect(record).toMatchObject({
      address: "notion@test",
      type: "application/agent-plugins+zip",
      connectors: [{ key: "notion", name: "com.notion/mcp" }],
      skills: [{ name: "notion", server: "notion" }, { name: "writing" }],
      starters: [{ title: "Find a page", text: "Help me find a Notion page." }],
    });
    expect(record?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record?.connectors[0]?.server.remotes?.[0]?.url).toBe(NOTION.url);

    // Bound: the connection's skill. Unbound: a managed skill in the workspace pool.
    const bound = join(workDir, "workspaces", wsId, "connector-skills", NOTION_SERVER, "notion.md");
    const unbound = join(workDir, "workspaces", wsId, "plugin-skills", "notion@test", "writing.md");
    expect(existsSync(bound)).toBe(true);
    expect(existsSync(unbound)).toBe(true);
    const names = rt.loadConversationSkills(wsId, ADMIN.id).map((s) => s.manifest.name);
    expect(names).toContain("plugin:notion@test:writing");
    // The connector list reads the plugin's record for the connection.
    const own = { kind: "workspace" as const, wsId };
    expect((await rt.getConnectorCatalog(own).catalogById("com.notion/mcp"))?.url).toBe(NOTION.url);

    const removed = await call({ action: "uninstall", address: "notion@test" });
    expect(removed.isError).toBe(false);
    expect(removed.structuredContent).toMatchObject({ removedConnectors: [NOTION_SERVER] });
    const after = await workspace(rt, wsId);
    expect(after.connectors).toEqual([]);
    expect(after.plugins ?? []).toEqual([]);
    expect(existsSync(bound)).toBe(false);
    expect(existsSync(unbound)).toBe(false);
    expect(await rt.getConnectorCatalog(own).catalogById("com.notion/mcp")).toBeNull();
  }, 30_000);

  test("Browse's row installs by its address, and uninstalling its connector removes the plugin", async () => {
    writeListing([
      publish("notion", notionPlugin(), {
        servers: { notion: { name: NOTION.name, auth: "dcr" } },
      }),
    ]);
    const { rt, wsId, call } = await boot();
    const dir = await call({ action: "list_directory" });
    const rows = (dir.structuredContent?.entries ?? []) as Array<Record<string, unknown>>;
    const row = rows.find((e) => e.address === "notion@test");
    expect(row).toBeDefined();
    const installed = await call({ action: "install", entry: row });
    expect(installed.structuredContent).toMatchObject({ serverName: NOTION_SERVER });
    const removed = await call({ action: "uninstall", serverName: NOTION_SERVER });
    expect(removed.isError).toBe(false);
    expect((await workspace(rt, wsId)).plugins ?? []).toEqual([]);
  }, 30_000);

  test("an entry with only an id installs the one listing entry that names its server", async () => {
    writeListing([
      publish("notion", notionPlugin(), {
        servers: { notion: { name: NOTION.name, auth: "dcr" } },
      }),
      bareConnectorEntry("linear", LINEAR),
    ]);
    const { rt, wsId, call } = await boot();
    const byId = (id: string, url = "https://forged.test/mcp") =>
      call({
        action: "install",
        entry: {
          id,
          name: id,
          description: "x",
          install: { kind: "remote-oauth", url, auth: "dcr" },
        },
      });

    // Named in a plugin's `servers`: the plugin installs, at its artifact's URL.
    const notion = await byId(NOTION.name);
    expect(notion.structuredContent).toMatchObject({ address: "notion@test" });
    // A bare connector's inline record names it: the one-item plugin installs.
    const linear = await byId(LINEAR.name);
    expect(linear.structuredContent).toMatchObject({ address: "linear@test" });
    const ws = await workspace(rt, wsId);
    expect(ws.plugins?.map((p) => p.address)).toEqual(["notion@test", "linear@test"]);
    expect(ws.connectors.map((c) => [c.serverName, c.url, c.installedBy])).toEqual([
      [NOTION_SERVER, NOTION.url, "notion@test"],
      [LINEAR_SERVER, LINEAR.url, "linear@test"],
    ]);
    // Nothing writes the old binding's lock.
    expect(ws.connectors.every((c) => c.skillsLock === undefined)).toBe(true);

    // An id no listing names is refused, and installs nothing.
    const unknown = await byId("com.unlisted/mcp");
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ error: "NOT_IN_CATALOG" });
    expect((await workspace(rt, wsId)).connectors).toHaveLength(2);
  }, 30_000);

  test("an id two listing entries name is refused with both addresses", async () => {
    writeListing([
      publish("notion", notionPlugin(), {
        servers: { notion: { name: NOTION.name, auth: "dcr" } },
      }),
      bareConnectorEntry("notion-bare", NOTION),
    ]);
    const { rt, wsId, call } = await boot();
    const result = await call({
      action: "install",
      entry: {
        id: NOTION.name,
        name: "Notion",
        description: "x",
        install: { kind: "remote-oauth", url: NOTION.url, auth: "dcr" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "AMBIGUOUS" });
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("notion@test");
    expect(text).toContain("notion-bare@test");
    expect((await workspace(rt, wsId)).connectors).toEqual([]);
  }, 30_000);

  test("an artifact that does not match its digest installs nothing", async () => {
    writeListing([publish("notion", notionPlugin(), { digest: `sha256:${"0".repeat(64)}` })]);
    const { rt, wsId, call } = await boot();
    const result = await call({ action: "install", address: "notion@test" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "DIGEST_MISMATCH" });
    const ws = await workspace(rt, wsId);
    expect(ws.connectors).toEqual([]);
    expect(ws.plugins ?? []).toEqual([]);
  }, 30_000);

  test("a plugin that runs a stdio server is refused", async () => {
    const bytes = pluginZip({ name: "local", servers: { tool: { ...NOTION, stdio: true } } });
    writeListing([publish("local", bytes)]);
    const { rt, wsId, call } = await boot();
    const result = await call({ action: "install", address: "local@test" });
    expect(result.structuredContent).toMatchObject({ error: "STDIO_SERVER" });
    expect((await workspace(rt, wsId)).connectors).toEqual([]);
  }, 30_000);

  test("a bare skill and a bare connector install as one-item plugins", async () => {
    const skill = new TextEncoder().encode(skillMd("notes", { body: "Keep notes short." }));
    writeListing([
      publish("notes", skill, { type: "application/agent-skills+md" }),
      bareConnectorEntry("linear", LINEAR),
    ]);
    const { rt, wsId, call } = await boot();

    const notes = await call({ action: "install", address: "notes@test" });
    expect(notes.structuredContent).toMatchObject({ ok: true, serverNames: [], skills: ["notes"] });
    const linear = await call({ action: "install", address: "linear@test" });
    expect(linear.structuredContent).toMatchObject({ ok: true, serverNames: [LINEAR_SERVER] });

    const ws = await workspace(rt, wsId);
    expect(
      ws.plugins?.map((p) => [p.address, p.type, p.connectors.length, p.skills.length]),
    ).toEqual([
      ["notes@test", "application/agent-skills+md", 0, 1],
      ["linear@test", "application/vnd.nimblebrain.server+json", 1, 0],
    ]);
    expect(ws.connectors.map((c) => c.serverName)).toEqual([LINEAR_SERVER]);
    expect(rt.loadConversationSkills(wsId, null).map((s) => s.manifest.name)).toContain(
      "plugin:notes@test:notes",
    );
  }, 30_000);

  test("two plugins share one connection; uninstalling one keeps it and hands over its record", async () => {
    const first = pluginZip({ name: "notion", servers: { notion: NOTION } });
    const second = pluginZip({
      name: "wiki",
      servers: { docs: { ...NOTION, url: NOTION.url } },
      skills: { wiki: skillMd("wiki", { server: "docs" }) },
    });
    writeListing([publish("notion", first), publish("wiki", second)]);
    const { rt, wsId, call } = await boot();

    await call({ action: "install", address: "notion@test" });
    const again = await call({ action: "install", address: "wiki@test" });
    expect(again.isError).toBe(false);
    let ws = await workspace(rt, wsId);
    expect(ws.connectors.map((c) => c.serverName)).toEqual([NOTION_SERVER]);
    expect(ws.plugins?.map((p) => p.address)).toEqual(["notion@test", "wiki@test"]);
    const supplier = async () =>
      (await rt.installedServerRecords({ kind: "workspace", wsId })).find(
        (r) => r.detail.name === NOTION.name,
      )?.address;
    expect(await supplier()).toBe("notion@test");

    // The connector two plugins use is not removed by name.
    const byName = await call({ action: "uninstall", serverName: NOTION_SERVER });
    expect(byName.structuredContent).toMatchObject({ error: "SHARED_CONNECTOR" });

    const removed = await call({ action: "uninstall", address: "notion@test" });
    expect(removed.structuredContent).toMatchObject({
      removedConnectors: [],
      keptConnectors: [NOTION_SERVER],
    });
    ws = await workspace(rt, wsId);
    expect(ws.connectors.map((c) => c.serverName)).toEqual([NOTION_SERVER]);
    expect(await supplier()).toBe("wiki@test");
    const wikiSkill = join(
      workDir,
      "workspaces",
      wsId,
      "connector-skills",
      NOTION_SERVER,
      "wiki.md",
    );
    expect(existsSync(wikiSkill)).toBe(true);

    await call({ action: "uninstall", address: "wiki@test" });
    ws = await workspace(rt, wsId);
    expect(ws.connectors).toEqual([]);
    expect(existsSync(wikiSkill)).toBe(false);
  }, 30_000);

  test("update replaces what the plugin owns when its digest moves, and only then", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, wsId, call } = await boot();
    await call({ action: "install", address: "notion@test" });
    const before = (await workspace(rt, wsId)).plugins?.[0];

    const current = await call({ action: "update_plugin", address: "notion@test" });
    expect(current.structuredContent).toMatchObject({ updated: false });

    const next = pluginZip({
      name: "notion",
      servers: { notion: NOTION, linear: LINEAR },
      skills: { pages: skillMd("pages", { server: "notion" }) },
    });
    writeListing([publish("notion", next)]);
    await rt.getCatalogListings().refresh();
    // A digest that moved is an update, never a silent reinstall.
    const reinstall = await call({ action: "install", address: "notion@test" });
    expect(reinstall.structuredContent).toMatchObject({ error: "UPDATE_AVAILABLE" });

    const updated = await call({ action: "update_plugin", address: "notion@test" });
    expect(updated.isError).toBe(false);
    const record = (await workspace(rt, wsId)).plugins?.[0];
    expect(record?.digest).not.toBe(before?.digest);
    expect(record?.installedAt).toBe(before?.installedAt as string);
    expect(record?.updatedAt).toBeDefined();
    expect(record?.skills.map((s) => s.name)).toEqual(["pages"]);
    expect((await workspace(rt, wsId)).connectors.map((c) => c.serverName).sort()).toEqual(
      [LINEAR_SERVER, NOTION_SERVER].sort(),
    );
    const skills = join(workDir, "workspaces", wsId, "connector-skills", NOTION_SERVER);
    expect(existsSync(join(skills, "notion.md"))).toBe(false);
    expect(existsSync(join(skills, "pages.md"))).toBe(true);
    expect(
      existsSync(join(workDir, "workspaces", wsId, "plugin-skills", "notion@test", "writing.md")),
    ).toBe(false);
  }, 30_000);

  test("an install that stopped before its record finishes on the next install", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, wsId, call } = await boot();
    await call({ action: "install", address: "notion@test" });
    // Stop before step 7: the connection and skills are there, the record is not.
    await rt.getWorkspaceStore().update(wsId, { plugins: [] });

    const again = await call({ action: "install", address: "notion@test" });
    expect(again.isError).toBe(false);
    const ws = await workspace(rt, wsId);
    expect(ws.connectors.map((c) => [c.serverName, c.installedBy])).toEqual([
      [NOTION_SERVER, "notion@test"],
    ]);
    expect(ws.plugins?.map((p) => p.address)).toEqual(["notion@test"]);
    // Served from the cache by digest: still one fetch.
    expect(artifactFetches()).toHaveLength(1);
  }, 30_000);

  test("a connector added by URL is untouched, and a plugin will not take its name", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, wsId, call } = await boot();
    const own = {
      url: "http://127.0.0.1:8000/mcp",
      serverName: "my-dev-server",
      transport: { type: "streamable-http" as const, auth: { type: "none" as const } },
      oauthScope: "workspace" as const,
    };
    await rt.getWorkspaceStore().update(wsId, { connectors: [own] });
    await call({ action: "install", address: "notion@test" });
    await call({ action: "uninstall", address: "notion@test" });
    let ws = await workspace(rt, wsId);
    expect(ws.connectors).toEqual([own]);
    expect(ws.plugins ?? []).toEqual([]);

    // The same name at another URL is the owner's: refused, not adopted.
    const clash = { ...own, serverName: NOTION_SERVER };
    await rt.getWorkspaceStore().update(wsId, { connectors: [clash] });
    const refused = await call({ action: "install", address: "notion@test" });
    expect(refused.structuredContent).toMatchObject({ error: "SERVER_CONFLICT" });
    ws = await workspace(rt, wsId);
    expect(ws.connectors).toEqual([clash]);
    expect(ws.plugins ?? []).toEqual([]);
  }, 30_000);

  test("a personal install records the plugin on the person, beside their connectors", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, call } = await boot();
    const result = await call({ action: "install", address: "notion@test", scope: "identity" });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      scope: "identity",
      serverName: NOTION_SERVER,
    });
    const store = new IdentityConnectorStore({ workDir: rt.getWorkDir() });
    expect((await store.list(ADMIN.id)).map((c) => c.serverName)).toEqual([NOTION_SERVER]);
    expect((await store.listPlugins(ADMIN.id)).map((p) => p.address)).toEqual(["notion@test"]);
    const removed = await call({ action: "uninstall", address: "notion@test", scope: "identity" });
    expect(removed.isError).toBe(false);
    expect(await store.list(ADMIN.id)).toEqual([]);
    expect(await store.listPlugins(ADMIN.id)).toEqual([]);
  }, 30_000);

  test("two workspaces install one server from two catalogs, and each reads its own record", async () => {
    // One registry name, two catalogs, two records: different title, placement, hook, admin tool.
    const variant = (label: string) =>
      pluginZip({
        name: "notion",
        servers: {
          notion: {
            ...NOTION,
            title: `Notion from ${label}`,
            host: {
              hostVersion: "1.5",
              placements: [
                {
                  slot: "sidebar.apps",
                  resourceUri: `ui://notion/${label}`,
                  label: `Notion ${label}`,
                },
              ],
              hooks: [
                { vendor: label, route: `/ingest/${label}`, registerTool: "set_webhook_url" },
              ],
              adminTools: [`configure_${label}`],
            },
          },
        },
      });
    const alphaListing = join(workDir, "alpha.json");
    const betaListing = join(workDir, "beta.json");
    writeFileSync(alphaListing, listingBytes([publish("notion", variant("alpha"))]));
    writeFileSync(betaListing, listingBytes([publish("notion", variant("beta"))]));
    const {
      rt,
      wsId: first,
      call,
    } = await boot([
      { source: alphaListing, policy: "available", name: "alpha" },
      { source: betaListing, policy: "available", name: "beta" },
    ]);
    const second = (
      await rt.getWorkspaceStore().create("Other", {
        members: [{ userId: ADMIN.id, role: "admin" }],
      })
    ).id;
    await rt.ensureWorkspaceRegistry(second);

    expect((await call({ action: "install", address: "notion@alpha" })).isError).toBe(false);
    const other = createManageConnectorsTool({
      runtime: rt,
      getIdentity: () => ADMIN,
      getWorkspaceId: () => second,
    });
    expect((await other.handler({ action: "install", address: "notion@beta" })).isError).toBe(
      false,
    );

    for (const [wsId, label] of [
      [first, "alpha"],
      [second, "beta"],
    ] as const) {
      const owner = { kind: "workspace" as const, wsId };
      const entry = await rt.getConnectorCatalog(owner).catalogById(NOTION.name);
      expect(entry?.name).toBe(`Notion from ${label}`);
      expect(entry?.ui?.placements?.map((p) => p.resourceUri)).toEqual([`ui://notion/${label}`]);
      expect(entry?.hooks?.map((h) => h.vendor)).toEqual([label]);
      expect(entry?.adminTools).toEqual({ kind: "names", names: [`configure_${label}`] });
      expect((await rt.connectorTitles(owner)).get(NOTION_SERVER)).toBe(`Notion from ${label}`);
      const placed = rt.getPlacementRegistry().forWorkspace(wsId);
      expect(placed.filter((p) => p.serverName === NOTION_SERVER).map((p) => p.label)).toEqual([
        `Notion ${label}`,
      ]);
    }
    // A read for no owner is the operator's list alone, which holds neither.
    expect(await rt.getConnectorCatalog().catalogById(NOTION.name)).toBeNull();

    // Uninstalling one workspace's plugin leaves the other's record in place.
    await call({ action: "uninstall", address: "notion@alpha" });
    const left = await rt
      .getConnectorCatalog({ kind: "workspace", wsId: second })
      .catalogById(NOTION.name);
    expect(left?.name).toBe("Notion from beta");
    expect(
      await rt.getConnectorCatalog({ kind: "workspace", wsId: first }).catalogById(NOTION.name),
    ).toBeNull();
  }, 30_000);
  test("a connector added by hand at the plugin's own URL is refused, never adopted", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, wsId, call } = await boot();
    const own = {
      url: NOTION.url,
      serverName: NOTION_SERVER,
      transport: { type: "streamable-http" as const },
      oauthScope: "workspace" as const,
    };
    await rt.getWorkspaceStore().update(wsId, { connectors: [own] });
    const refused = await call({ action: "install", address: "notion@test" });
    expect(refused.structuredContent).toMatchObject({ error: "SERVER_CONFLICT" });
    const ws = await workspace(rt, wsId);
    expect(ws.connectors).toEqual([own]);
    expect(ws.plugins ?? []).toEqual([]);

    // A person's own connector is theirs the same way.
    const store = new IdentityConnectorStore({ workDir: rt.getWorkDir() });
    const { oauthScope: _scope, ...personal } = own;
    await store.add(ADMIN.id, personal);
    const mine = await call({ action: "install", address: "notion@test", scope: "identity" });
    expect(mine.structuredContent).toMatchObject({ error: "SERVER_CONFLICT" });
    expect(await store.list(ADMIN.id)).toEqual([personal]);
    expect(await store.listPlugins(ADMIN.id)).toEqual([]);

    // A connection another plugin's unfinished install left is not taken either.
    await rt
      .getWorkspaceStore()
      .update(wsId, { connectors: [{ ...own, installedBy: "other@test" }] });
    const left = await call({ action: "install", address: "notion@test" });
    expect(left.structuredContent).toMatchObject({ error: "SERVER_CONFLICT" });
  }, 30_000);

  test("overlapping installs and uninstalls for one owner keep every record", async () => {
    writeListing([
      publish("notion", notionPlugin()),
      publish("wiki", pluginZip({ name: "wiki", servers: { docs: NOTION } })),
      bareConnectorEntry("linear", LINEAR),
      publish("notes", new TextEncoder().encode(skillMd("notes")), {
        type: "application/agent-skills+md",
      }),
    ]);
    const { rt, wsId, call } = await boot();
    const both = await Promise.all([
      call({ action: "install", address: "notion@test" }),
      call({ action: "install", address: "linear@test" }),
    ]);
    expect(both.map((r) => r.isError)).toEqual([false, false]);
    let ws = await workspace(rt, wsId);
    expect(ws.plugins?.map((p) => p.address).sort()).toEqual(["linear@test", "notion@test"]);
    expect(ws.connectors.map((c) => c.serverName).sort()).toEqual(
      [LINEAR_SERVER, NOTION_SERVER].sort(),
    );

    await Promise.all([
      call({ action: "uninstall", address: "notion@test" }),
      call({ action: "install", address: "notes@test" }),
    ]);
    ws = await workspace(rt, wsId);
    expect(ws.plugins?.map((p) => p.address).sort()).toEqual(["linear@test", "notes@test"]);
    expect(ws.connectors.map((c) => c.serverName)).toEqual([LINEAR_SERVER]);

    // Two uninstalls of the plugins sharing a connection: each decides on the
    // other's outcome, so the last one removes it.
    await call({ action: "install", address: "notion@test" });
    await call({ action: "install", address: "wiki@test" });
    await Promise.all([
      call({ action: "uninstall", address: "notion@test" }),
      call({ action: "uninstall", address: "wiki@test" }),
    ]);
    ws = await workspace(rt, wsId);
    expect(ws.connectors.map((c) => c.serverName)).toEqual([LINEAR_SERVER]);

    // The same for a person, whose records share connectors.json with their connectors.
    const store = new IdentityConnectorStore({ workDir: rt.getWorkDir() });
    await Promise.all([
      call({ action: "install", address: "notion@test", scope: "identity" }),
      call({ action: "install", address: "linear@test", scope: "identity" }),
    ]);
    expect((await store.listPlugins(ADMIN.id)).map((p) => p.address).sort()).toEqual([
      "linear@test",
      "notion@test",
    ]);
    await Promise.all([
      call({ action: "uninstall", address: "notion@test", scope: "identity" }),
      call({ action: "install", address: "notes@test", scope: "identity" }),
    ]);
    expect((await store.listPlugins(ADMIN.id)).map((p) => p.address).sort()).toEqual([
      "linear@test",
      "notes@test",
    ]);
    expect((await store.list(ADMIN.id)).map((c) => c.serverName)).toEqual([LINEAR_SERVER]);
  }, 30_000);

  test("an update that moves its server's URL moves the connection, signs it out, and survives a restart", async () => {
    writeListing([publish("notion", notionPlugin())]);
    const { rt, wsId, call } = await boot();
    await call({ action: "install", address: "notion@test" });
    await call({ action: "install", address: "notion@test", scope: "identity" });
    const workspaceTokens = new McpOAuthRecords({
      owner: { type: "workspace", wsId },
      serverName: NOTION_SERVER,
    });
    const personTokens = new McpOAuthRecords({
      owner: { type: "user", userId: ADMIN.id },
      serverName: NOTION_SERVER,
    });
    await workspaceTokens.write("tokens", { access_token: "old-origin" });
    await personTokens.write("tokens", { access_token: "old-origin" });

    const moved = "https://mcp.notion-next.test/mcp";
    const next = pluginZip({ name: "notion", servers: { notion: { ...NOTION, url: moved } } });
    writeListing([publish("notion", next)]);
    await rt.getCatalogListings().refresh();

    const updated = await call({ action: "update_plugin", address: "notion@test" });
    expect(updated.structuredContent).toMatchObject({
      updated: true,
      reconnectedConnectors: [NOTION_SERVER],
    });
    const ws = await workspace(rt, wsId);
    expect(ws.connectors.map((c) => [c.url, c.installedBy])).toEqual([[moved, "notion@test"]]);
    expect(rt.getLifecycle().getInstance(NOTION_SERVER, wsId)?.ref?.url).toBe(moved);
    expect(await workspaceTokens.has("tokens")).toBe(false);

    const mine = await call({ action: "update_plugin", address: "notion@test", scope: "identity" });
    expect(mine.structuredContent).toMatchObject({ reconnectedConnectors: [NOTION_SERVER] });
    const store = new IdentityConnectorStore({ workDir: rt.getWorkDir() });
    expect((await store.list(ADMIN.id)).map((c) => c.url)).toEqual([moved]);
    expect(await personTokens.has("tokens")).toBe(false);

    // An update with nothing to move reconnects nothing.
    const plain = pluginZip({
      name: "notion",
      servers: { notion: { ...NOTION, url: moved } },
      skills: { more: skillMd("more") },
    });
    writeListing([publish("notion", plain)]);
    await rt.getCatalogListings().refresh();
    const again = await call({ action: "update_plugin", address: "notion@test" });
    expect(again.structuredContent).toMatchObject({ updated: true, reconnectedConnectors: [] });

    // After a restart the connection reads the moved URL, bound to the plugin's record.
    await rt.shutdown();
    runtime = null;
    const restarted = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
      catalogs: [{ source: listingPath, policy: "available", name: "test" }],
    });
    runtime = restarted;
    await restarted.ensureWorkspaceRegistry(wsId);
    expect(restarted.getLifecycle().getInstance(NOTION_SERVER, wsId)?.ref?.url).toBe(moved);
    const own = { kind: "workspace" as const, wsId };
    expect((await restarted.getConnectorCatalog(own).catalogByUrl()).get(moved)?.id).toBe(
      NOTION.name,
    );
  }, 30_000);

  // An update stopped at any step, then retried, leaves no credential minted
  // for the old settings and reports the sign-in it owes.
  const interruptions: Array<{
    at: string;
    arm: (rt: Runtime, owner: "workspace" | "identity") => () => void;
  }> = [
    {
      at: "the credentials could not be deleted",
      arm: () => {
        const original = McpOAuthRecords.prototype.deleteAll;
        McpOAuthRecords.prototype.deleteAll = async () => {
          throw new Error("injected: delete failed");
        };
        return () => {
          McpOAuthRecords.prototype.deleteAll = original;
        };
      },
    },
    {
      at: "the credentials were deleted",
      arm: (rt, owner) => {
        const lifecycle = rt.getLifecycle();
        const key = owner === "workspace" ? "replaceConnectionRef" : "signOutIdentityConnector";
        const original = lifecycle[key];
        Object.assign(lifecycle, {
          [key]: async (...args: unknown[]) => {
            await (original as (...a: unknown[]) => Promise<void>).apply(lifecycle, args);
            throw new Error("injected: after credential deletion");
          },
        });
        return () => Object.assign(lifecycle, { [key]: original });
      },
    },
    {
      at: "the new settings were stored",
      arm: (rt, owner) => {
        if (owner === "identity") {
          const original = IdentityConnectorStore.prototype.add;
          IdentityConnectorStore.prototype.add = async function (
            this: IdentityConnectorStore,
            ...a
          ) {
            await original.apply(this, a);
            throw new Error("injected: after settings persist");
          };
          return () => {
            IdentityConnectorStore.prototype.add = original;
          };
        }
        const store = rt.getWorkspaceStore();
        const original = store.update;
        store.update = async (...a: Parameters<typeof store.update>) => {
          const result = await original.apply(store, a);
          if (a[1].connectors) throw new Error("injected: after settings persist");
          return result;
        };
        return () => {
          store.update = original;
        };
      },
    },
    {
      at: "every connection moved, before the record",
      arm: (rt) => {
        const records = rt.getPluginRecords();
        const original = records.put;
        records.put = async () => {
          throw new Error("injected: before record write");
        };
        return () => {
          records.put = original;
        };
      },
    },
  ];

  for (const owner of ["workspace", "identity"] as const) {
    for (const { at, arm } of interruptions) {
      test(`${owner}: an update stopped after ${at} signs out on retry`, async () => {
        writeListing([publish("notion", notionPlugin())]);
        const { rt, wsId, call } = await boot();
        const scope = owner === "identity" ? { scope: "identity" } : {};
        await call({ action: "install", address: "notion@test", ...scope });
        const tokens = new McpOAuthRecords({
          owner:
            owner === "workspace"
              ? { type: "workspace", wsId }
              : { type: "user", userId: ADMIN.id },
          serverName: NOTION_SERVER,
        });
        await tokens.write("tokens", { access_token: "old-origin" });

        const moved = "https://mcp.notion-next.test/mcp";
        writeListing([
          publish(
            "notion",
            pluginZip({ name: "notion", servers: { notion: { ...NOTION, url: moved } } }),
          ),
        ]);
        await rt.getCatalogListings().refresh();
        const storedUrl = async () =>
          owner === "workspace"
            ? (await workspace(rt, wsId)).connectors[0]?.url
            : (await new IdentityConnectorStore({ workDir }).get(ADMIN.id, NOTION_SERVER))?.url;

        const disarm = arm(rt, owner);
        const failed = await call({
          action: "update_plugin",
          address: "notion@test",
          ...scope,
        }).then(
          (r) => r.isError === true,
          () => true,
        );
        disarm();
        expect(failed).toBe(true);
        // New settings are never stored beside the old credentials.
        if ((await storedUrl()) === moved) expect(await tokens.has("tokens")).toBe(false);

        const retried = await call({ action: "update_plugin", address: "notion@test", ...scope });
        expect(retried.structuredContent).toMatchObject({
          updated: true,
          reconnectedConnectors: [NOTION_SERVER],
        });
        expect(await storedUrl()).toBe(moved);
        expect(await tokens.has("tokens")).toBe(false);
        if (owner === "workspace") {
          expect(rt.getLifecycle().getInstance(NOTION_SERVER, wsId)?.ref?.url).toBe(moved);
        }
      }, 30_000);
    }
  }

  test("an update of a plugin that shares a server another plugin supplies leaves the connection", async () => {
    const wiki = (url: string) =>
      pluginZip({ name: "wiki", servers: { docs: { ...NOTION, url } } });
    writeListing([
      publish("notion", pluginZip({ name: "notion", servers: { notion: NOTION } })),
      publish("wiki", wiki(NOTION.url)),
    ]);
    const { rt, wsId, call } = await boot();
    await call({ action: "install", address: "notion@test" });
    await call({ action: "install", address: "wiki@test" });

    writeListing([
      publish("notion", pluginZip({ name: "notion", servers: { notion: NOTION } })),
      publish("wiki", wiki("https://mcp.notion-next.test/mcp")),
    ]);
    await rt.getCatalogListings().refresh();
    const updated = await call({ action: "update_plugin", address: "wiki@test" });
    expect(updated.structuredContent).toMatchObject({ updated: true, reconnectedConnectors: [] });
    expect((await workspace(rt, wsId)).connectors.map((c) => c.url)).toEqual([NOTION.url]);
  }, 30_000);

  test("an item its available catalog drops stays installed and shows as no longer offered", async () => {
    writeListing([bareConnectorEntry("linear", LINEAR), bareConnectorEntry("notion", NOTION)]);
    const { rt, wsId, call } = await boot();
    await call({ action: "install", address: "linear@test" });
    const plugins = async () =>
      ((await call({ action: "list_plugins" })).structuredContent as PluginsListOutput).plugins;
    expect((await plugins())[0]?.noLongerOffered).toBeUndefined();

    writeListing([bareConnectorEntry("notion", NOTION)]);
    await rt.getCatalogListings().refresh();
    const [linear] = await plugins();
    expect(linear?.servers.map((s) => s.serverName)).toEqual([LINEAR_SERVER]);
    expect(linear?.noLongerOffered).toBe(true);
    expect(linear?.required).toBeUndefined();
    expect((await workspace(rt, wsId)).plugins?.map((p) => p.address)).toEqual(["linear@test"]);
    const update = await call({ action: "update_plugin", address: "linear@test" });
    expect(update.structuredContent).toMatchObject({ error: "NOT_OFFERED" });

    // Its catalog leaving the configuration says the same; uninstall still works.
    const other = join(workDir, "other.json");
    writeFileSync(other, listingBytes([]));
    await rt.shutdown();
    const restarted = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
      catalogs: [{ source: other, policy: "available", name: "other" }],
    });
    runtime = restarted;
    await restarted.ensureWorkspaceRegistry(wsId);
    const again = createManageConnectorsTool({
      runtime: restarted,
      getIdentity: () => ADMIN,
      getWorkspaceId: () => wsId,
    });
    const listed = (await again.handler({ action: "list_plugins" }))
      .structuredContent as PluginsListOutput;
    expect(listed.plugins[0]?.noLongerOffered).toBe(true);
    const removed = await again.handler({ action: "uninstall", address: "linear@test" });
    expect(removed.isError).toBe(false);
  }, 30_000);

  test("an item whose entry its available catalog rejects as invalid is not shown as no longer offered", async () => {
    writeListing([bareConnectorEntry("linear", LINEAR), bareConnectorEntry("notion", NOTION)]);
    const { rt, call } = await boot();
    await call({ action: "install", address: "linear@test" });
    writeListing([
      { ...bareConnectorEntry("linear", LINEAR), digest: "sha256:not-hex" },
      bareConnectorEntry("notion", NOTION),
    ]);
    await rt.getCatalogListings().refresh();
    const [linear] = (
      (await call({ action: "list_plugins" })).structuredContent as PluginsListOutput
    ).plugins;
    expect(linear?.servers.map((s) => s.serverName)).toEqual([LINEAR_SERVER]);
    expect(linear?.noLongerOffered).toBeUndefined();
  }, 30_000);

  test("a static plugin row reads its setup from that one artifact only at set-up", async () => {
    const LEDGER: FixtureServer = {
      name: "com.acme/ledger",
      url: "https://mcp.ledger.test/mcp",
      meta: {
        auth: "static",
        oauthClientSetup: {
          portalUrl: "https://developer.ledger.test/",
          hint: "Create an OAuth app",
          clientSecretKey: "ledger.client_secret",
        },
      },
    };
    const ledger = pluginZip({ name: "ledger", servers: { ledger: LEDGER } });
    writeListing([
      publish("ledger", ledger, { servers: { ledger: { name: LEDGER.name, auth: "static" } } }),
      publish("notion", notionPlugin(), {
        servers: { notion: { name: NOTION.name, auth: "dcr" } },
      }),
    ]);
    const { rt, wsId, call } = await boot();
    type Row = CatalogListing & { address?: string };
    const rows = async () =>
      ((await call({ action: "list_directory" })).structuredContent as { entries: Row[] }).entries;

    const row = (await rows()).find((e) => e.address === "ledger@test");
    expect(row).toMatchObject({ status: "setup", setupFromArtifact: true });
    expect(artifactFetches()).toEqual([]);

    const setup = await call({ action: "get_setup", address: "ledger@test" });
    const entry = (setup.structuredContent as { entry: Row }).entry;
    expect(entry.install).toMatchObject({
      url: LEDGER.url,
      auth: "static",
      oauthClientSetup: LEDGER.meta?.oauthClientSetup,
    });
    expect(entry.setupFromArtifact).toBeUndefined();
    expect(artifactFetches()).toHaveLength(1);
    await call({ action: "get_setup", address: "ledger@test" });
    expect(artifactFetches()).toHaveLength(1);

    const saved = await call({
      action: "set_oauth_client",
      catalogId: LEDGER.name,
      address: "ledger@test",
      clientId: "cid",
      clientSecret: "secret",
    });
    expect(saved.isError).toBe(false);
    expect((await rows()).find((e) => e.address === "ledger@test")?.status).toBe("ready");

    const installed = await call({ action: "install", address: "ledger@test" });
    expect(installed.isError).toBe(false);
    const ref = (await workspace(rt, wsId)).connectors.find(
      (c) => c.serverName === "com-acme-ledger",
    );
    expect(ref?.oauthClient).toMatchObject({ clientId: "cid" });
  }, 30_000);
});
