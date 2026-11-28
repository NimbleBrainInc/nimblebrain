/**
 * Adopting existing installs into plugins at boot (ADR-0077, "Existing
 * installs"): a connector a catalog install made before records existed (its
 * `skillsLock` records a plugin) is adopted when exactly one listing entry
 * names its server and that entry's verified artifact contains it. Otherwise
 * it stays exactly as it is. After adoption, starters and the plugin list read
 * the record, and nothing opens an archive again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginCatalogConfig } from "../../src/config/plugin-catalog.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { InstalledPluginRecord } from "../../src/plugins/installed/record.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { materializeConnectorSkill } from "../../src/skills/connector-skill-store.ts";
import { parseSkillFile } from "../../src/skills/loader.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { adoptExistingInstalls } from "../../src/tools/plugin-adopt.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { listingBytes } from "../helpers/ai-catalog.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import {
  artifactEntry,
  type FixtureServer,
  pluginZip,
  skillMd,
} from "../helpers/plugin-artifacts.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS = "ws_0077a0d0b0e0f001";
const ADMIN: UserIdentity = {
  id: "usr_adopt_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};
const PERSON = "usr_adopt_person";

const NOTION: FixtureServer = {
  name: "com.notion/mcp",
  url: "https://mcp.notion.test/mcp",
  meta: { auth: "dcr" },
};
const NOTION_SERVER = "com-notion-mcp";

let workDir: string;
let listingPath: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let objects: Map<string, Uint8Array>;
let requests: string[];
let runtime: Runtime | null;
let savedDir: string | undefined;

beforeEach(() => {
  workDir = join(tmpdir(), `nb-plugin-adopt-${crypto.randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
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

function publish(
  name: string,
  bytes: Uint8Array,
  servers: Record<string, { name: string; auth: string }>,
): Record<string, unknown> {
  const { entry, path } = artifactEntry({ name, bytes, base, servers });
  objects.set(path, bytes);
  return entry;
}

function writeListing(entries: unknown[]): void {
  writeFileSync(listingPath, listingBytes(entries));
}

const notionPlugin = (servers: Record<string, FixtureServer> = { notion: NOTION }) =>
  pluginZip({
    name: "notion",
    servers,
    skills: {
      notion: skillMd("notion", { server: "notion", body: "Notion guidance, from the plugin." }),
      writing: skillMd("writing", { body: "Write well." }),
    },
    starters: [{ title: "Find a page", text: "Help me find a Notion page." }],
  });

const NOTION_CLAIM = { notion: { name: NOTION.name, auth: "dcr" } };

/** A connector as a pre-record catalog install stored it: its lock names the plugin and server. */
function preRecordRef(server: FixtureServer, serverName: string): ConnectorRef {
  return {
    url: server.url,
    serverName,
    oauthScope: "workspace",
    skillsLock: [
      {
        plugin: "notion@nimblebrain",
        server: server.name,
        skill: "notion",
        // At the current pin, so the old reconcile has nothing to re-bind.
        version: resolvePluginCatalogConfig().sha256,
        digest: "0".repeat(64),
        sha: "1".repeat(64),
      },
    ],
  };
}

/** The workspace with `refs`, and the old binding's skill files in its connector-skills store. */
async function seedPreRecordWorkspace(refs: ConnectorRef[]): Promise<void> {
  const store = new WorkspaceStore(workDir);
  await seedWorkspace(store, WS, { members: [{ userId: ADMIN.id, role: "admin" }] });
  await store.update(WS, { connectors: refs });
  const dir = connectorSkillsDir();
  for (const ref of refs.filter((r) => r.skillsLock)) {
    for (const skill of ["notion", "retired"]) {
      materializeConnectorSkill({
        connectorSkillsDir: dir,
        serverName: ref.serverName,
        overlayBody: skillMd(skill, { body: `Old ${skill} guidance.` }),
        source: `plugin:notion@nimblebrain:${skill}`,
        now: new Date().toISOString(),
      });
    }
  }
}

function connectorSkillsDir(): string {
  return join(workDir, "workspaces", WS, "connector-skills");
}

async function boot(): Promise<Runtime> {
  const rt = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    catalogs: [{ source: listingPath, policy: "available", name: "test" }],
  });
  runtime = rt;
  return rt;
}

async function stop(): Promise<void> {
  await runtime?.shutdown();
  runtime = null;
}

async function workspaceRecord(rt: Runtime) {
  const ws = await rt.getWorkspaceStore().get(WS);
  if (!ws) throw new Error("no workspace");
  return ws;
}

function artifactFetches(): string[] {
  return requests.filter((p) => p.startsWith("/artifacts/"));
}

describe("adopting existing installs at boot", () => {
  test("one claimant: record written, skills moved once, starters and plugin list from it", async () => {
    await seedPreRecordWorkspace([preRecordRef(NOTION, NOTION_SERVER)]);
    writeListing([publish("notion", notionPlugin(), NOTION_CLAIM)]);
    const rt = await boot();

    expect(artifactFetches()).toHaveLength(1);
    const ws = await workspaceRecord(rt);
    const ref = ws.connectors[0];
    expect(ref?.installedBy).toBe("notion@test");
    expect(ref?.skillsLock).toBeUndefined();
    expect(ref?.url).toBe(NOTION.url);
    const record = ws.plugins?.[0] as InstalledPluginRecord;
    expect(ws.plugins).toHaveLength(1);
    expect(record).toMatchObject({
      address: "notion@test",
      connectors: [{ key: "notion", name: NOTION.name }],
      skills: [{ name: "notion", server: "notion" }, { name: "writing" }],
      starters: [{ title: "Find a page", text: "Help me find a Notion page." }],
    });
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The bound skill is rewritten in place under the plugin; the old
    // binding's skill the plugin no longer carries is gone.
    const dir = join(connectorSkillsDir(), NOTION_SERVER);
    expect(readdirSync(dir).sort()).toEqual(["notion.md"]);
    const skill = parseSkillFile(join(dir, "notion.md"), { cap: false });
    expect(skill?.manifest.provenance?.source).toBe("plugin:notion@test:notion");
    expect(readFileSync(join(dir, "notion.md"), "utf-8")).toContain("from the plugin");
    expect(
      existsSync(join(workDir, "workspaces", WS, "plugin-skills", "notion@test", "writing.md")),
    ).toBe(true);

    // Starters and the plugin list read the record: no archive, no index.
    const before = requests.length;
    const starters = createCoreToolDefs(rt).find((t) => t.name === "conversation_starters");
    const res = await runWithRequestContext({ identity: ADMIN, workspaceId: WS }, () =>
      starters?.handler({}),
    );
    expect(res?.structuredContent).toEqual({
      conversationStarters: [
        {
          serverName: NOTION_SERVER,
          plugin: "notion",
          title: "Find a page",
          text: "Help me find a Notion page.",
        },
      ],
    });
    const tool = createManageConnectorsTool({
      runtime: rt,
      getIdentity: () => ADMIN,
      getWorkspaceId: () => WS,
    });
    const listed = await tool.handler({ action: "list_plugins" });
    const plugins = (listed.structuredContent as { plugins: Array<Record<string, unknown>> })
      .plugins;
    expect(plugins.map((p) => p.id)).toEqual(["workspace:plugin:notion@test"]);
    expect(requests.slice(before).filter((p) => !p.endsWith("ai-catalog.json"))).toEqual([]);

    // A second boot finds nothing to adopt and reads no artifact, even uncached.
    await stop();
    rmSync(join(workDir, "cache", "plugins"), { recursive: true, force: true });
    const fetched = requests.length;
    const again = await boot();
    expect(requests.length).toBe(fetched);
    expect((await workspaceRecord(again)).plugins).toEqual(ws.plugins);
    expect(readdirSync(dir)).toEqual(["notion.md"]);
  });

  test("zero claimants: the connector stays as it was", async () => {
    const ref = preRecordRef(NOTION, NOTION_SERVER);
    await seedPreRecordWorkspace([ref]);
    writeListing([
      publish("other", notionPlugin(), { other: { name: "com.other/mcp", auth: "dcr" } }),
    ]);
    const rt = await boot();

    expect(artifactFetches()).toEqual([]);
    const ws = await workspaceRecord(rt);
    expect(ws.connectors).toEqual([ref]);
    expect(ws.plugins ?? []).toEqual([]);
    expect(readdirSync(join(connectorSkillsDir(), NOTION_SERVER)).sort()).toEqual([
      "notion.md",
      "retired.md",
    ]);
  });

  test("two claimants: the connector stays as it was, and both are reported", async () => {
    const ref = preRecordRef(NOTION, NOTION_SERVER);
    await seedPreRecordWorkspace([ref]);
    writeListing([
      publish("notion", notionPlugin(), NOTION_CLAIM),
      publish(
        "notion-alt",
        pluginZip({ name: "notion-alt", servers: { notion: NOTION } }),
        NOTION_CLAIM,
      ),
    ]);
    const rt = await boot();

    expect(artifactFetches()).toEqual([]);
    const ws = await workspaceRecord(rt);
    expect(ws.connectors).toEqual([ref]);
    expect(ws.plugins ?? []).toEqual([]);

    const result = await adoptExistingInstalls({
      workDir,
      workspaces: rt.getWorkspaceStore(),
      records: rt.getPluginRecords(),
      snapshots: () => rt.getCatalogListings().snapshots(),
    });
    expect(result.adopted).toEqual([]);
    expect(result.unchanged).toEqual([
      {
        owner: { kind: "workspace", wsId: WS },
        serverName: NOTION_SERVER,
        claimants: ["notion@test", "notion-alt@test"],
        why: "more than one listing entry names its server",
      },
    ]);
  });

  test("an artifact that does not contain the server: the connector stays as it was", async () => {
    const ref = preRecordRef(NOTION, NOTION_SERVER);
    await seedPreRecordWorkspace([ref]);
    const elsewhere = { notion: { ...NOTION, name: "com.notion/other" } };
    writeListing([publish("notion", notionPlugin(elsewhere), NOTION_CLAIM)]);
    const rt = await boot();

    expect(artifactFetches()).toHaveLength(1);
    const ws = await workspaceRecord(rt);
    expect(ws.connectors).toEqual([ref]);
    expect(ws.plugins ?? []).toEqual([]);
  });

  test("a connector its owner added by URL is never adopted", async () => {
    const byUrl: ConnectorRef = {
      url: NOTION.url,
      serverName: NOTION_SERVER,
      oauthScope: "workspace",
      display: { title: "My Notion" },
    };
    await seedPreRecordWorkspace([byUrl]);
    writeListing([publish("notion", notionPlugin(), NOTION_CLAIM)]);
    const rt = await boot();

    expect(artifactFetches()).toEqual([]);
    const ws = await workspaceRecord(rt);
    expect(ws.connectors).toEqual([byUrl]);
    expect(ws.plugins ?? []).toEqual([]);
  });

  test("a person's connector is adopted into their own record", async () => {
    const store = new WorkspaceStore(workDir);
    await seedWorkspace(store, WS, { members: [{ userId: ADMIN.id, role: "admin" }] });
    const identity = new IdentityConnectorStore({ workDir });
    const { oauthScope: _scope, ...personal } = preRecordRef(NOTION, NOTION_SERVER);
    await identity.add(PERSON, { url: "https://first.test/mcp", serverName: "first" });
    await identity.add(PERSON, personal);
    writeListing([publish("notion", notionPlugin(), NOTION_CLAIM)]);
    const rt = await boot();

    expect(artifactFetches()).toHaveLength(1);
    const refs = await identity.list(PERSON);
    expect(refs.map((r) => r.serverName)).toEqual(["first", NOTION_SERVER]);
    expect(refs[1]?.installedBy).toBe("notion@test");
    expect(refs[1]?.skillsLock).toBeUndefined();
    const records = await identity.listPlugins(PERSON);
    expect(records.map((r) => r.address)).toEqual(["notion@test"]);
    expect(
      existsSync(join(workDir, "users", PERSON, "connector-skills", NOTION_SERVER, "notion.md")),
    ).toBe(true);
    // The workspace has nothing to adopt.
    expect((await workspaceRecord(rt)).plugins ?? []).toEqual([]);
  });

  test("an adoption that stopped after its record finishes marking the connector, with no fetch", async () => {
    const ref = preRecordRef(NOTION, NOTION_SERVER);
    await seedPreRecordWorkspace([ref]);
    writeListing([publish("notion", notionPlugin(), NOTION_CLAIM)]);
    const record: InstalledPluginRecord = {
      address: "notion@test",
      digest: `sha256:${"a".repeat(64)}`,
      type: "application/agent-plugins+zip",
      installedAt: new Date().toISOString(),
      connectors: [
        {
          key: "notion",
          name: NOTION.name,
          server: {
            name: NOTION.name,
            version: "1.0.0",
            description: "Notion",
            remotes: [{ type: "streamable-http", url: NOTION.url }],
          },
        },
      ],
      skills: [],
      starters: [],
    };
    await new WorkspaceStore(workDir).update(WS, { plugins: [record] });
    const rt = await boot();

    expect(artifactFetches()).toEqual([]);
    const ws = await workspaceRecord(rt);
    expect(ws.connectors[0]?.installedBy).toBe("notion@test");
    expect(ws.connectors[0]?.skillsLock).toBeUndefined();
    expect(ws.plugins).toEqual([record]);
  });
});
