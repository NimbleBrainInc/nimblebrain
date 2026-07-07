/**
 * Integration tests: personal-connector surfacing.
 *
 * A personal connector is an MCP bundle a user installed in their OWN personal
 * workspace (`ws_user_<userId>`). `listToolsForWorkspace(wsId, identityId)`
 * surfaces it into a *shared* room's tool list as a BARE `<connector>__<tool>`
 * identity tool — but ONLY when the owner granted it to that room. In the
 * owner's own personal workspace it is already surfaced namespaced (via that
 * workspace's registry), so it is not duplicated bare.
 *
 * Setup: one dev-mode Runtime; a shared workspace (Helix, dev is a member) with
 * a `crm` source; the dev's personal workspace with two personal connectors —
 * `granola` (granted to Helix) and `notion` (NOT granted). Asserting on one
 * list keeps the grant FILTER order-independent.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const testDir = join(tmpdir(), `nb-pc-surfacing-${Date.now()}`);
const SHARED_WS = "ws_helix";

let runtime: Runtime;
let personalWs: string;

function buildSource(name: string, tool: string) {
  return defineInProcessApp(
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
}

async function register(wsId: string, name: string, tool: string): Promise<void> {
  const source = buildSource(name, tool);
  await source.start();
  (await runtime.ensureWorkspaceRegistry(wsId)).addSource(source);
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
  });

  const wsStore = runtime.getWorkspaceStore();
  await wsStore.create("Helix", SHARED_WS.slice(3));
  await wsStore.addMember(SHARED_WS, DEV_IDENTITY.id, "admin");
  await ensureUserWorkspace(wsStore, {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  personalWs = personalWorkspaceIdFor(DEV_IDENTITY.id);

  // Shared-room source, so granted personal connectors must be *additive*.
  await register(SHARED_WS, "crm", "search");
  // Two personal connectors in the owner's own personal workspace.
  await register(personalWs, "granola", "read_notes");
  await register(personalWs, "notion", "read");

  // Grant only granola into the shared room.
  await runtime.getPermissionStore().grantConnector(DEV_IDENTITY.id, "granola", SHARED_WS);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("personal-connector surfacing", () => {
  it("surfaces ONLY granted personal connectors, bare, into a shared room", async () => {
    const names = await toolNames(SHARED_WS, DEV_IDENTITY.id);

    // Granted → bare identity-door form.
    expect(names).toContain("granola__read_notes");
    // Ungranted → absent (deny by default).
    expect(names).not.toContain("notion__read");
    // A personal connector is never surfaced namespaced cross-room (that would
    // hit the wall).
    expect(names).not.toContain(`${personalWs}-granola__read_notes`);
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

  it("in the owner's own personal workspace, connectors are namespaced — no duplicate bare", async () => {
    const names = await toolNames(personalWs, DEV_IDENTITY.id);

    // Reached via that workspace's own registry, namespaced — both connectors,
    // grant-independent (home is free).
    expect(names).toContain(`${personalWs}-granola__read_notes`);
    expect(names).toContain(`${personalWs}-notion__read`);
    // NOT also surfaced as bare identity-door tools (would be a duplicate).
    expect(names).not.toContain("granola__read_notes");
    expect(names).not.toContain("notion__read");
  });
});
