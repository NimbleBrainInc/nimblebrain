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
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
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
let savedDir: string | undefined;

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
  savedDir = process.env[CATALOG_DIR_ENV];
  delete process.env[CATALOG_DIR_ENV];
  runtime = null;
});

afterEach(async () => {
  await runtime?.shutdown();
  await server.stop(true);
  if (savedDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = savedDir;
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

async function boot(): Promise<{
  rt: Runtime;
  wsId: string;
  call: (input: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const rt = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    catalogs: [{ source: listingPath, policy: "available", name: "test" }],
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
    expect((await rt.getConnectorCatalog().catalogById("com.notion/mcp"))?.url).toBe(NOTION.url);

    const removed = await call({ action: "uninstall", address: "notion@test" });
    expect(removed.isError).toBe(false);
    expect(removed.structuredContent).toMatchObject({ removedConnectors: [NOTION_SERVER] });
    const after = await workspace(rt, wsId);
    expect(after.connectors).toEqual([]);
    expect(after.plugins ?? []).toEqual([]);
    expect(existsSync(bound)).toBe(false);
    expect(existsSync(unbound)).toBe(false);
    expect(await rt.getConnectorCatalog().catalogById("com.notion/mcp")).toBeNull();
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
      (await rt.installedServerRecords()).find((r) => r.detail.name === NOTION.name)?.address;
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
    expect(ws.connectors.map((c) => c.serverName)).toEqual([NOTION_SERVER]);
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
});
