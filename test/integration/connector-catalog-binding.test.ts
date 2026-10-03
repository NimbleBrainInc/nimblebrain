/**
 * A catalog entry's grants reach an installed connector only when the ref IS
 * the entry's server: the entry's name AND the entry's URL.
 *
 * One `Runtime`, one catalog entry declaring `admin_tools`, a lifecycle handler
 * and a hook, and two workspaces where the dev identity is a member. Each holds
 * a ref under the entry's server name: one at the entry's URL, one at another
 * server's. The first is gated by the entry; the second runs as a plain remote
 * connector, with none of the entry's grants, and the operator is told once.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { log } from "../../src/observability/log.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const AT_ENTRY_URL = "ws_00a4f0c1d2e3b4a5";
const AT_OTHER_URL = "ws_00b5e1d2c3f4a5b6";
/** `slugifyServerName("ai.acme/crm")`. */
const SERVER = "ai-acme-crm";
const ENTRY_URL = "https://crm.acme.test/mcp";

const testDir = join(tmpdir(), `nb-catalog-binding-${Date.now()}`);
const catalogDir = join(testDir, "catalog");

const CATALOG_YAML = `servers:
  - name: ai.acme/crm
    title: Acme CRM
    description: Test connector with catalog grants
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${ENTRY_URL}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        host_version: "1.5"
        admin_tools: [configure]
        lifecycle:
          on_ready: workspace_ready
        hooks:
          - vendor: acme
            route: /ingest/acme
            register_tool: set_webhook_url
`;

const ran = new Map<string, string[]>();

function buildSource(wsId: string) {
  const log: string[] = [];
  ran.set(wsId, log);
  const tool = (name: string) => ({
    name,
    description: `Acme ${name}.`,
    inputSchema: { type: "object" as const, properties: {} },
    handler: async () => {
      log.push(name);
      return { content: textContent(`${name} ok`), isError: false };
    },
  });
  return defineInProcessApp(
    {
      name: SERVER,
      version: "1.0.0",
      tools: [tool("configure"), tool("workspace_ready"), tool("set_webhook_url")],
    },
    new NoopEventSink(),
  );
}

let runtime: Runtime;
let savedCatalogDir: string | undefined;

beforeAll(async () => {
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "acme.yaml"), CATALOG_YAML);
  savedCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;

  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });

  const wsStore = runtime.getWorkspaceStore();
  for (const [wsId, url] of [
    [AT_ENTRY_URL, ENTRY_URL],
    [AT_OTHER_URL, "https://crm.other.test/mcp"],
  ] as const) {
    await seedWorkspace(wsStore, wsId, { name: wsId });
    await wsStore.addMember(wsId, DEV_IDENTITY.id, "member");
    const source = buildSource(wsId);
    await source.start();
    (await runtime.ensureWorkspaceRegistry(wsId)).addSource(source);
    await wsStore.update(wsId, { connectors: [{ url, serverName: SERVER }] });
  }
});

afterAll(async () => {
  stopAllToolSurfaceWatches();
  await runtime.shutdown();
  if (savedCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = savedCatalogDir;
  rmSync(testDir, { recursive: true, force: true });
});

async function call(wsId: string, tool: string) {
  const router = new IdentityToolRouter({
    caller: "chat",
    identityId: DEV_IDENTITY.id,
    workspaceId: wsId,
    runtime,
  });
  return router.execute({ id: `c-${tool}`, name: `${SERVER}__${tool}`, input: {} });
}

describe("a connector at the catalog entry's URL", () => {
  it("is held to the entry's admin_tools and lifecycle", async () => {
    const admin = await call(AT_ENTRY_URL, "configure");
    expect(admin.structuredContent).toMatchObject({ error: "workspace_admin_required" });
    const hostOnly = await call(AT_ENTRY_URL, "workspace_ready");
    expect(hostOnly.isError).toBe(true);
    expect(ran.get(AT_ENTRY_URL)).toEqual([]);
  });

  it("gets the entry's hook and lifecycle declarations", async () => {
    const hooks = await runtime.getHookReconcileDeps().declarationsFor(AT_ENTRY_URL, SERVER);
    expect(hooks.map((h) => h.vendor)).toEqual(["acme"]);
    const lifecycle = await runtime.getLifecycleNotifyDeps().declarationFor(AT_ENTRY_URL, SERVER);
    expect(lifecycle?.on_ready).toBe("workspace_ready");
  });
});

describe("a connector under the entry's name at another URL", () => {
  it("gets none of the entry's grants, still runs, and is reported once", async () => {
    const warn = spyOn(log, "warn");
    try {
      const configure = await call(AT_OTHER_URL, "configure");
      expect(configure.isError).toBe(false);
      const ready = await call(AT_OTHER_URL, "workspace_ready");
      expect(ready.isError).toBe(false);
      expect(ran.get(AT_OTHER_URL)).toEqual(["configure", "workspace_ready"]);

      expect(await runtime.getHookReconcileDeps().declarationsFor(AT_OTHER_URL, SERVER)).toEqual(
        [],
      );
      expect(
        await runtime.getLifecycleNotifyDeps().declarationFor(AT_OTHER_URL, SERVER),
      ).toBeUndefined();

      const reported = warn.mock.calls.filter((c) =>
        String(c[0]).includes(`"${SERVER}" in ${AT_OTHER_URL} carries the server name`),
      );
      expect(reported).toHaveLength(1);
      // The ref's URL is never logged: it may carry a credential.
      expect(JSON.stringify(reported)).not.toContain("crm.other.test");
    } finally {
      warn.mockRestore();
    }
  });
});
