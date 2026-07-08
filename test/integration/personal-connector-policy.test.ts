import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type FakeConnectorServer, startFakeConnectorServer } from "../helpers/fake-connector-server.ts";

/**
 * Integration: a personal connector is an IDENTITY-owned source, resolved by
 * userId on the identity door and lazy-started from the caller's
 * `connectors.json`. Reachability in a workspace is governed uniformly by the
 * grant — including the user's OWN personal workspace, which is just a
 * workspace (no "free at home"). The owner's `{scope:"user"}` per-tool
 * `disallow` policy travels with the connector, so a granted connector is never
 * more capable than the owner permits.
 *
 * Setup: dev user; a shared workspace (Helix, dev is a member); `granola`
 * (read_notes + delete_notes; granted to Helix; delete_notes disallowed) and
 * `notion` (read; installed but NOT granted) — both installed on the identity.
 */

const testDir = join(tmpdir(), `nb-pc-policy-${Date.now()}`);
const SHARED_WS = "ws_helix";

let runtime: Runtime;
let personalWs: string;
let handle: ServerHandle;
let baseUrl: string;
const servers: FakeConnectorServer[] = [];

async function installConnector(serverName: string, toolNames: string[]): Promise<void> {
  const server = startFakeConnectorServer(toolNames);
  servers.push(server);
  await new IdentityConnectorStore({ workDir: testDir }).add(DEV_IDENTITY.id, {
    url: server.url,
    serverName,
    ui: null,
  });
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
    // The fake connector servers bind on localhost.
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

  await installConnector("granola", ["read_notes", "delete_notes"]);
  await installConnector("notion", ["read"]); // installed but NOT granted

  const store = runtime.getPermissionStore();
  await store.grantConnector(DEV_IDENTITY.id, "granola", SHARED_WS);
  // The owner disallowed delete_notes on their own connector — identity-scoped.
  await store.setConnector({ scope: "user", userId: DEV_IDENTITY.id }, "granola", {
    delete_notes: "disallow",
  });

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  for (const s of servers) s.close();
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
});

describe("personal-connector reachability — a personal workspace is just a workspace", () => {
  it("an ungranted connector is denied in the owner's OWN personal workspace (no free-at-home)", async () => {
    // granola is NOT granted to the personal workspace — only to Helix. The
    // personal workspace gets no special treatment, so it's grant-gated too.
    const homeRouter = new IdentityToolRouter({
      identityId: DEV_IDENTITY.id,
      workspaceId: personalWs,
      runtime,
    });
    const result = await homeRouter.execute({ id: "h1", name: "granola__read_notes", input: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ reason: "connector_grant_denied" });
  });

  it("granting to the personal workspace makes it reachable there — same as any workspace", async () => {
    const store = runtime.getPermissionStore();
    await store.grantConnector(DEV_IDENTITY.id, "notion", personalWs);
    try {
      const homeRouter = new IdentityToolRouter({
        identityId: DEV_IDENTITY.id,
        workspaceId: personalWs,
        runtime,
      });
      const result = await homeRouter.execute({ id: "h2", name: "notion__read", input: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await store.revokeConnector(DEV_IDENTITY.id, "notion", personalWs);
    }
  });
});

describe("personal-connector per-tool policy — surfacing (surface = dispatchable)", () => {
  it("advertises granted allowed tools but not the disallowed one", async () => {
    const names = (await runtime.listToolsForWorkspace(SHARED_WS, DEV_IDENTITY.id)).map(
      (t) => t.name,
    );
    expect(names).toContain("granola__read_notes"); // granted + allowed
    expect(names).not.toContain("granola__delete_notes"); // granted but disallowed
    expect(names).not.toContain("notion__read"); // not granted to Helix
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
