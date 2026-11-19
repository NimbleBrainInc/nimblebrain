/**
 * The Plugins page demo's seed (`scripts/lib/plugins-demo/`): seeded twice into
 * one workdir, then booted, the runtime lists every plugin in the state the
 * fixtures name, with nothing duplicated.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  DEMO_WORKSPACES,
  MOCK_SERVERS,
  PERSONAL_PLUGINS,
} from "../../scripts/lib/plugins-demo/fixtures.ts";
import { type MockFleet, startMockFleet } from "../../scripts/lib/plugins-demo/mock-servers.ts";
import { type SeedSummary, seedPluginsDemo } from "../../scripts/lib/plugins-demo/seed.ts";
import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import type { PluginsListOutput } from "../../src/platform/schemas/plugins.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

const CATALOG_DIR = join(import.meta.dir, "../../.environments/plugins-demo/catalog");
const { workDir, cleanup } = makeTestWorkDir("plugins-demo-seed");

let fleet: MockFleet;
let runtime: Runtime;
let handle: ServerHandle;
let summary: SeedSummary;
const previousCatalogDir = process.env[CATALOG_DIR_ENV];

beforeAll(async () => {
  process.env[CATALOG_DIR_ENV] = CATALOG_DIR;
  fleet = startMockFleet(MOCK_SERVERS);
  await seedPluginsDemo({ workDir, catalogDir: CATALOG_DIR, fleet });
  summary = await seedPluginsDemo({ workDir, catalogDir: CATALOG_DIR, fleet });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    allowInsecureRemotes: true,
  });
  handle = startServer({ runtime, port: 0 });
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  fleet.close();
  if (previousCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = previousCatalogDir;
  cleanup();
});

async function listPlugins(wsId: string): Promise<PluginsListOutput> {
  const res = await fetch(`http://localhost:${handle.port}/v1/workspaces/${wsId}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server: "nb",
      tool: "manage_connectors",
      arguments: { action: "list_plugins" },
    }),
  });
  const body = await readJson<ToolCallResponse>(res);
  return body.structuredContent as PluginsListOutput;
}

const STATUS_OF = {
  ready: "ready",
  failed: "failed",
  "needs-sign-in": "not_connected",
  "sign-in-expired": "needs_auth",
  "needs-setup": "needs_setup",
} as const;

describe("the plugins demo seed", () => {
  it("creates each workspace once, however often it runs", async () => {
    const all = await new WorkspaceStore(workDir).list();
    expect(all.map((w) => w.name).sort()).toEqual(DEMO_WORKSPACES.map((w) => w.name).sort());
    for (const ws of all) {
      const demo = DEMO_WORKSPACES.find((d) => d.name === ws.name);
      expect(ws.connectors).toHaveLength(demo?.plugins.length ?? -1);
    }
  });

  it("boots every workspace plugin into the state the fixture names", async () => {
    for (const ws of summary.workspaces) {
      const demo = DEMO_WORKSPACES.find((d) => d.name === ws.name);
      const { plugins } = await listPlugins(ws.id);
      const counts: Record<string, number> = {};
      for (const p of plugins.filter((p) => p.owner.kind === "workspace")) {
        const status = p.servers[0]?.status ?? "missing";
        counts[status] = (counts[status] ?? 0) + 1;
      }
      const expected: Record<string, number> = {};
      for (const p of demo?.plugins ?? []) {
        expected[STATUS_OF[p.state]] = (expected[STATUS_OF[p.state]] ?? 0) + 1;
      }
      expect({ ws: ws.name, counts }).toEqual({ ws: ws.name, counts: expected });
    }
  });

  it("lists the personal plugins, signed in and granted as the fixture names", async () => {
    const support = summary.workspaces.find((w) => w.name === "Acme Support");
    const { plugins } = await listPlugins(support?.id ?? "");
    const personal = plugins.filter((p) => p.owner.kind === "person");
    expect(personal).toHaveLength(PERSONAL_PLUGINS.length);
    const signedIn = personal.filter((p) => p.servers[0]?.status === "ready").length;
    expect(signedIn).toBe(PERSONAL_PLUGINS.filter((p) => p.connected).length);
    const granted = personal.filter((p) => p.granted).length;
    expect(granted).toBe(
      PERSONAL_PLUGINS.filter((p) => p.grantedIn.includes("Acme Support")).length,
    );
  });

  it("shows the views and published skills of the connected mock servers", async () => {
    const support = summary.workspaces.find((w) => w.name === "Acme Support");
    const { plugins } = await listPlugins(support?.id ?? "");
    const helpdesk = plugins.find((p) => p.id === "workspace:helpdesk");
    expect(helpdesk?.apps.map((a) => a.label)).toEqual(["Ticket Queue"]);
    expect(helpdesk?.skills.map((s) => `${s.kind}:${s.name}`).sort()).toEqual([
      "published:reply-tone",
      "published:triage-playbook",
    ]);
    expect(helpdesk?.servers[0]?.account).toEqual({ email: "support@acme.example" });
    const billing = plugins.find((p) => p.id === "workspace:billing-desk");
    expect(billing?.servers[0]?.account).toBeNull();
  });
});
