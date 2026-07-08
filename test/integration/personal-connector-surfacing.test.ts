/**
 * Integration tests: personal-connector surfacing.
 *
 * A personal connector is an IDENTITY-owned MCP connection (installed on the
 * user, in `connectors.json`). `listToolsForWorkspace(wsId, identityId)`
 * surfaces it into a workspace's tool list as a BARE `<connector>__<tool>`
 * identity tool — but ONLY when the owner granted it to that workspace. This is
 * uniform across every workspace, including the user's OWN personal one (a
 * personal workspace is just a workspace): grant-gated, and never namespaced.
 *
 * Setup: one dev-mode Runtime; a shared workspace (Helix, dev is a member) with
 * a `crm` workspace source; two personal connectors on the identity — `granola`
 * (granted to Helix) and `notion` (NOT granted). Asserting on one list keeps the
 * grant FILTER order-independent.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type FakeConnectorServer, startFakeConnectorServer } from "../helpers/fake-connector-server.ts";

const testDir = join(tmpdir(), `nb-pc-surfacing-${Date.now()}`);
const SHARED_WS = "ws_helix";

let runtime: Runtime;
let personalWs: string;
const servers: FakeConnectorServer[] = [];

/** An in-process WORKSPACE source (e.g. the room's own `crm`). */
async function registerWorkspaceSource(wsId: string, name: string, tool: string): Promise<void> {
  const source = defineInProcessApp(
    {
      name,
      version: "1.0.0",
      tools: [
        {
          name: tool,
          description: `${name} ${tool}`,
          inputSchema: { type: "object", properties: {} },
          handler: async () => ({ content: textContent("ok"), isError: false }),
        },
      ],
    },
    new NoopEventSink(),
  );
  await source.start();
  (await runtime.ensureWorkspaceRegistry(wsId)).addSource(source);
}

/** A personal connector, installed on the identity (remote, lazy-started). */
async function installConnector(serverName: string, tool: string): Promise<void> {
  const server = startFakeConnectorServer([tool]);
  servers.push(server);
  await new IdentityConnectorStore({ workDir: testDir }).add(DEV_IDENTITY.id, {
    url: server.url,
    serverName,
    ui: null,
  });
}

async function toolNames(wsId: string, identityId?: string): Promise<string[]> {
  return (await runtime.listToolsForWorkspace(wsId, identityId)).map((t) => t.name);
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    allowInsecureRemotes: true,
  });

  const wsStore = runtime.getWorkspaceStore();
  await wsStore.create("Helix", SHARED_WS.slice(3));
  await wsStore.addMember(SHARED_WS, DEV_IDENTITY.id, "admin");
  await ensureUserWorkspace(wsStore, {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  personalWs = personalWorkspaceIdFor(DEV_IDENTITY.id);

  // Shared-room workspace source, so granted personal connectors must be *additive*.
  await registerWorkspaceSource(SHARED_WS, "crm", "search");
  // Two personal connectors on the identity.
  await installConnector("granola", "read_notes");
  await installConnector("notion", "read");

  // Grant only granola into the shared room.
  await runtime.getPermissionStore().grantConnector(DEV_IDENTITY.id, "granola", SHARED_WS);
});

afterAll(async () => {
  await runtime.shutdown();
  for (const s of servers) s.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("personal-connector surfacing", () => {
  it("surfaces ONLY granted personal connectors, bare, into a shared room", async () => {
    const names = await toolNames(SHARED_WS, DEV_IDENTITY.id);

    // Granted → bare identity-door form.
    expect(names).toContain("granola__read_notes");
    // Ungranted → absent (deny by default).
    expect(names).not.toContain("notion__read");
    // A personal connector is never surfaced namespaced (that would hit the wall).
    expect(names).not.toContain(`${SHARED_WS}-granola__read_notes`);
    // Additive: the room's own tools and the kernel identity tools remain.
    expect(names).toContain("ws_helix-crm__search");
    expect(names).toContain("conversations__list");
  });

  it("surfaces no personal connectors without an identity, even when granted", async () => {
    const names = await toolNames(SHARED_WS);
    expect(names).not.toContain("granola__read_notes");
    expect(names).not.toContain("notion__read");
    // Workspace + kernel identity tools are unaffected.
    expect(names).toContain("ws_helix-crm__search");
  });

  it("in the owner's own personal workspace: bare + grant-gated, never namespaced (no free-at-home)", async () => {
    // A personal workspace is just a workspace — grant it explicitly.
    await runtime.getPermissionStore().grantConnector(DEV_IDENTITY.id, "granola", personalWs);
    try {
      const names = await toolNames(personalWs, DEV_IDENTITY.id);
      // Granted → bare; never namespaced.
      expect(names).toContain("granola__read_notes");
      expect(names).not.toContain(`${personalWs}-granola__read_notes`);
      // notion is NOT granted to the personal workspace → absent (no free-at-home).
      expect(names).not.toContain("notion__read");
    } finally {
      await runtime.getPermissionStore().revokeConnector(DEV_IDENTITY.id, "granola", personalWs);
    }
  });

  // Locks the door wiring: the engine's own tool surface (IdentityToolRouter,
  // the primary consumer) forwards its captured identityId, so surfacing fires
  // end-to-end and not just when listToolsForWorkspace is called directly. The
  // /mcp and nb__search doors forward identity the same way.
  it("surfaces through IdentityToolRouter.availableTools (the engine door)", async () => {
    const router = new IdentityToolRouter({
      identityId: DEV_IDENTITY.id,
      workspaceId: SHARED_WS,
      runtime,
    });
    const names = (await router.availableTools()).map((t) => t.name);
    expect(names).toContain("granola__read_notes"); // granted
    expect(names).not.toContain("notion__read"); // ungranted
  });
});
