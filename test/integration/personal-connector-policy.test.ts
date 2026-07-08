/**
 * Integration tests: personal-connector per-tool policy + door parity.
 *
 * When a personal connector is used in a shared room via the identity door, the
 * OWNER'S per-tool `disallow` policy must be honored — read from the connector's
 * home workspace (`{scope:"workspace", ws_user_<owner>}`), the SAME policy the
 * workspace door consults at home. So a granted connector is never MORE capable
 * in a shared room than in its own home. This is enforced on every door that can
 * reach a personal connector (the chat engine and `/mcp`) and mirrored in
 * surfacing (a disallowed tool is not advertised).
 *
 * Setup: one dev-mode Runtime; a shared workspace (Helix, dev is a member); the
 * dev's personal workspace with `granola` (read_notes + delete_notes; granted to
 * Helix; delete_notes disallowed) and `notion` (read; NOT granted).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const testDir = join(tmpdir(), `nb-pc-policy-${Date.now()}`);
const SHARED_WS = "ws_helix";

let runtime: Runtime;
let personalWs: string;
let handle: ServerHandle;
let baseUrl: string;

function buildSource(name: string, tools: string[]) {
  return defineInProcessApp(
    {
      name,
      version: "1.0.0",
      tools: tools.map((t) => ({
        name: t,
        description: `${name} ${t}`,
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("ok"), isError: false }),
      })),
    },
    new NoopEventSink(),
  );
}

async function register(wsId: string, name: string, tools: string[]): Promise<void> {
  const source = buildSource(name, tools);
  await source.start();
  (await runtime.ensureWorkspaceRegistry(wsId)).addSource(source);
}

async function mcpClient(workspace: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { "x-workspace-id": workspace } },
  });
  const client = new Client({ name: "pc-policy-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
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

  await register(personalWs, "granola", ["read_notes", "delete_notes"]);
  await register(personalWs, "notion", ["read"]); // installed but NOT granted

  const store = runtime.getPermissionStore();
  await store.grantConnector(DEV_IDENTITY.id, "granola", SHARED_WS);
  // The owner disallowed delete_notes on their own connector — its home policy.
  await store.setConnector({ scope: "workspace", wsId: personalWs }, "granola", {
    delete_notes: "disallow",
  });

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("personal-connector per-tool policy — engine door", () => {
  it("allows a granted, non-disallowed tool", async () => {
    const router = new IdentityToolRouter({
      identityId: DEV_IDENTITY.id,
      workspaceId: SHARED_WS,
      runtime,
    });
    const result = await router.execute({ id: "c1", name: "granola__read_notes", input: {} });
    expect(result.isError).toBeFalsy();
  });

  it("denies a tool the owner disallowed, before it runs", async () => {
    const router = new IdentityToolRouter({
      identityId: DEV_IDENTITY.id,
      workspaceId: SHARED_WS,
      runtime,
    });
    const result = await router.execute({ id: "c2", name: "granola__delete_notes", input: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "tool_permission_denied",
      connector: "granola",
      tool: "delete_notes",
    });
  });

  it("home and shared room are symmetric — the same disallow holds in the owner's own workspace", async () => {
    // At home the connector is reached via the WORKSPACE door (namespaced); the
    // same {scope:"workspace", ws_user_} policy denies it there too.
    const homeRouter = new IdentityToolRouter({
      identityId: DEV_IDENTITY.id,
      workspaceId: personalWs,
      runtime,
    });
    const result = await homeRouter.execute({
      id: "h1",
      name: `${personalWs}-granola__delete_notes`,
      input: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "tool_permission_denied" });
  });
});

describe("personal-connector per-tool policy — surfacing (surface = dispatchable)", () => {
  it("does not advertise a disallowed tool", async () => {
    const names = (await runtime.listToolsForWorkspace(SHARED_WS, DEV_IDENTITY.id)).map(
      (t) => t.name,
    );
    expect(names).toContain("granola__read_notes"); // granted + allowed
    expect(names).not.toContain("granola__delete_notes"); // granted but disallowed
  });
});

describe("personal-connector per-tool policy — /mcp door parity", () => {
  it("denies a disallowed tool via /mcp with the same envelope", async () => {
    const client = await mcpClient(SHARED_WS);
    try {
      const result = await client.callTool({ name: "granola__delete_notes", arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error?: string })?.error).toBe(
        "tool_permission_denied",
      );
      // The safe granted tool still works on the same door.
      const ok = await client.callTool({ name: "granola__read_notes", arguments: {} });
      expect(ok.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("maps a grant denial to a clean connector_grant_denied error (not a server error)", async () => {
    const client = await mcpClient(SHARED_WS);
    try {
      // notion is a personal connector but NOT granted to Helix.
      await client.callTool({ name: "notion__read", arguments: {} });
      throw new Error("expected a JSON-RPC error");
    } catch (err) {
      const e = err as { data?: { reason?: string } };
      expect(e.data?.reason).toBe("connector_grant_denied");
    } finally {
      await client.close();
    }
  });
});
