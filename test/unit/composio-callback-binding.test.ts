import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// Broker mock: records every call made with the platform-wide key.
const broker = {
  linkArgs: [] as unknown[],
  linkCalls: 0,
  deleted: [] as string[],
  got: [] as string[],
};
mock.module("@composio/core", () => ({
  // Shape-complete vendor seam: every `@composio/core` registration exports
  // `AuthScheme` (see composio-auth.test.ts).
  AuthScheme: { APIKey: (p: Record<string, string>) => ({ authScheme: "API_KEY", val: p }) },
  Composio: class {
    connectedAccounts = {
      list: async () => ({ items: [] }),
      link: async (...args: unknown[]) => {
        broker.linkArgs = args;
        broker.linkCalls++;
        return { redirectUrl: "https://connect.broker.test/link/lk_1", id: "ca_linked_own" };
      },
      initiate: () => {
        throw new Error("unused");
      },
      // Another owner's account, which a callback must never adopt.
      get: async (id: string) => {
        broker.got.push(id);
        return id === "ca_other_owner"
          ? { id, user_id: "tenant-a:ws_b", state: { val: { displayName: "other@ws-b.test" } } }
          : { id, state: { val: { displayName: "me@ws-a.test" } } };
      },
      delete: async (id: string) => {
        broker.deleted.push(id);
      },
    };
    create = async () => ({ mcp: { type: "http", url: "https://broker.test/mcp/x" } });
  },
}));

import type { AuthMiddlewareOptions } from "../../src/api/auth-middleware.ts";
import type { ApiErrorBody } from "../../src/api/schemas/responses.ts";
import type { AppContext, AppEnv } from "../../src/api/types.ts";
import type { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import { _clearAllConnectFlows } from "../../src/connectors/providers/composio/connect-flow-registry.ts";
import { readComposioConnection } from "../../src/connectors/providers/composio/connection.ts";
import { composioAuthRoutes } from "../../src/connectors/providers/composio/routes.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import type { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import type { ConnectorInstance } from "../../src/connectors/runtime/types.ts";
import type { EventSink } from "../../src/engine/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { FIRST_PARTY_GRANT, type IdentityProvider } from "../../src/identity/provider.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import type { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { readJson } from "../helpers/http.ts";
import { stub } from "../helpers/stub.ts";
import { makeWorkspace, seedWorkspaceRoot } from "../helpers/test-workspace.ts";

/**
 * The Composio callback completes a flow only in the browser its initiate
 * bound, persists only the connected account `link()` created for that flow,
 * and consumes the flow on the first bound callback whatever it says.
 */

const WS_A = "ws_0076759dbbe19fcc";
const CID = "com.google/gmail";
const ENTRY = {
  id: CID,
  name: "Gmail",
  description: "t",
  iconUrl: "https://example.com/i.png",
  url: "https://broker.test/mcp",
  auth: "composio" as const,
  composio: { toolkit: "gmail" },
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let dir = "";
let installed = true;
const calls = { state: [] as string[] };

/** Every request authenticates as `usr_member`: role "member" in ws-a. */
function makeApp(): Hono<AppEnv> {
  const auth = stub<AuthMiddlewareOptions>({
    provider: stub<IdentityProvider>({
      verifyRequest: async () => ({
        ...DEV_IDENTITY,
        id: "usr_member",
        orgRole: "member",
        grant: FIRST_PARTY_GRANT,
      }),
    }),
    eventSink: stub<EventSink>({ emit: () => {} }),
  });
  const runtime = stub<Runtime>({
    getConnectorCatalog: () =>
      stub<ConnectorCatalog>({ catalogById: async (id: string) => (id === CID ? ENTRY : null) }),
    getWorkDir: () => dir,
    getLifecycle: () =>
      stub<ConnectorLifecycleManager>({
        getInstance: (serverName: string, wsId: string) =>
          installed && serverName === slugifyServerName(CID) && wsId === WS_A
            ? stub<ConnectorInstance>({})
            : null,
        ensureSourceRegistered: async () => {},
        recordConnectionStateChange: (_s: string, _w: string, _p: string, st: string) => {
          calls.state.push(st);
        },
        getIdentityConnectorSource: async () => stub<ToolSource>({}),
      }),
    resolveRequestUserId: () => "usr_member",
    getIdentityProvider: () => null,
    assertConversationInWorkspace: () => {},
  });
  const ctx = stub<AppContext>({
    runtime,
    workspaceStore: stub<WorkspaceStore>({
      get: async (id: string) =>
        id === WS_A
          ? makeWorkspace({
              id,
              members: [
                { userId: "usr_admin", role: "admin" },
                { userId: "usr_member", role: "member" },
              ],
            })
          : null,
    }),
    authOptions: auth,
  });
  const app = new Hono<AppEnv>();
  app.route("/", composioAuthRoutes(ctx));
  return app;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["COMPOSIO_API_KEY", "NB_TENANT_ID", "NB_PUBLIC_ORIGIN"])
    saved[k] = process.env[k];
  process.env.NB_PUBLIC_ORIGIN = "https://nb.test";
  process.env.COMPOSIO_API_KEY = "k_platform_wide";
  process.env.NB_TENANT_ID = "tenant-a";
  _resetComposioConfigForTest();
  setConnectorsConfig({ providers: { composio: { authConfigs: { gmail: "ac_gmail" } } } });
  dir = mkdtempSync(join(tmpdir(), "nb-composio-binding-"));
  seedWorkspaceRoot(dir, WS_A);
  installed = true;
  broker.linkCalls = 0;
  broker.deleted = [];
  broker.got = [];
  calls.state = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetComposioConfigForTest();
  _resetConnectorsConfigForTest();
  _clearAllConnectFlows();
  rmSync(dir, { recursive: true, force: true });
});

const PERSONAL = { type: "user" as const, userId: "usr_member" };

/** Install the connector on the member's identity and start a personal connect. Returns the flow's nonce and cookie. */
async function startPersonal(app: Hono<AppEnv>): Promise<{ nonce: string; cookie: string }> {
  await new IdentityConnectorStore({ workDir: dir }).add("usr_member", {
    url: "https://mcp.example.com/x",
    serverName: slugifyServerName(CID),
    ui: null,
  });
  const init = await app.request("http://nb.test/v1/composio-auth/initiate-identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectorId: CID }),
  });
  expect(init.status).toBe(200);
  return started(init);
}

function started(init: Response): { nonce: string; cookie: string } {
  const callbackUrl = (broker.linkArgs[2] as { callbackUrl: string }).callbackUrl;
  const nonce = new URL(callbackUrl).searchParams.get("n") ?? "";
  const value = /^__Host-nb_composio_state=([0-9a-f]{64});/.exec(
    init.headers.get("set-cookie") ?? "",
  )?.[1];
  return { nonce, cookie: `__Host-nb_composio_state=${value}` };
}

const callback = (nonce: string, query: string) =>
  `http://nb.test/v1/composio-auth/callback?n=${nonce}&${query}`;

test("persists the account link() created for the flow", async () => {
  const app = makeApp();
  const { nonce, cookie } = await startPersonal(app);

  const cb = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie } },
  );

  expect(cb.status).toBe(302);
  const conn = await readComposioConnection(dir, PERSONAL, CID);
  expect(conn?.connectedAccountId).toBe("ca_linked_own");
  expect(conn?.displayName).toBe("me@ws-a.test");
  expect(broker.got).toEqual(["ca_linked_own"]);
});

test("a callback naming another account is refused: nothing persisted, read or deleted at the broker", async () => {
  const app = makeApp();
  const { nonce, cookie } = await startPersonal(app);

  const cb = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_other_owner"),
    { headers: { cookie } },
  );

  expect(cb.status).toBe(400);
  expect(await readComposioConnection(dir, PERSONAL, CID)).toBeNull();
  expect(broker.got).toEqual([]);
  expect(broker.deleted).toEqual([]);
  // The flow was consumed: the right id cannot be tried on it afterwards.
  const retry = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie } },
  );
  expect(await retry.text()).toContain("Unknown or expired");
});

test("a denied consent consumes the flow, so the nonce cannot be replayed", async () => {
  const app = makeApp();
  const { nonce, cookie } = await startPersonal(app);

  const denied = await app.request(callback(nonce, "status=failed"), { headers: { cookie } });
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain("Connection failed");

  const replay = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie } },
  );
  expect(replay.status).toBe(400);
  expect(await replay.text()).toContain("Unknown or expired");
  expect(await readComposioConnection(dir, PERSONAL, CID)).toBeNull();
});

test("an error= callback consumes the flow too", async () => {
  const app = makeApp();
  const { nonce, cookie } = await startPersonal(app);

  expect(
    (await app.request(callback(nonce, "error=access_denied"), { headers: { cookie } })).status,
  ).toBe(400);
  const replay = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie } },
  );
  expect(await replay.text()).toContain("Unknown or expired");
});

test("a cookie computed from the nonce is refused and does not end the flow", async () => {
  const app = makeApp();
  const { nonce, cookie } = await startPersonal(app);

  const forged = await app.request(
    callback(nonce, "status=failed&connected_account_id=ca_linked_own"),
    { headers: { cookie: `__Host-nb_composio_state=${sha(nonce)}` } },
  );
  expect(forged.status).toBe(400);
  expect(await forged.text()).toContain("Authorization session mismatch");

  const own = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie } },
  );
  expect(own.status).toBe(302);
});

test("a workspace connect for a connector not installed in the workspace is refused before the broker", async () => {
  installed = false;
  const app = makeApp();
  const init = await app.request(`http://nb.test/v1/workspaces/${WS_A}/composio-auth/initiate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectorId: CID }),
  });

  expect(init.status).toBe(404);
  expect((await readJson<ApiErrorBody>(init)).error).toBe("connector_not_found");
  expect(broker.linkCalls).toBe(0);
  expect(init.headers.get("set-cookie")).toBeNull();
});

test("a workspace connect for an installed connector persists only its own account", async () => {
  const app = makeApp();
  const init = await app.request(`http://nb.test/v1/workspaces/${WS_A}/composio-auth/initiate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectorId: CID }),
  });
  expect(init.status).toBe(200);
  const { nonce, cookie } = started(init);

  // No status and an arbitrary id: not this flow's account, so nothing lands.
  const cb = await app.request(callback(nonce, "connected_account_id=ca_anything"), {
    headers: { cookie },
  });
  expect(cb.status).toBe(400);
  const owner = { type: "workspace" as const, wsId: WS_A };
  expect(await readComposioConnection(dir, owner, CID)).toBeNull();
  expect(calls.state).toEqual([]);
});

test("only the __Host- cookie completes the flow, not the same value under the bare name", async () => {
  const app = makeApp();
  const { nonce, cookie } = await startPersonal(app);
  expect(cookie).toStartWith("__Host-nb_composio_state=");

  // The same value under the bare name is not the flow cookie.
  const bare = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie: cookie.replace("__Host-", "") } },
  );
  expect(bare.status).toBe(400);

  const cb = await app.request(
    callback(nonce, "status=success&connected_account_id=ca_linked_own"),
    { headers: { cookie } },
  );
  expect(cb.status).toBe(302);
  expect(cb.headers.get("set-cookie")).toBe(
    "__Host-nb_composio_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure",
  );
});
