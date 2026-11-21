/**
 * Integration tests: a personal connector's MCP App (its `ui://` view) renders
 * and acts in a workspace where its owner granted it, over its own connection.
 *
 * Setup: one dev-mode Runtime and HTTP server; workspace A holds a workspace
 * source `fixture`, and the dev identity holds a personal connector of the same
 * server name `fixture`, granted to A and not to B. The two serve different
 * bytes, so every read and call says which connection answered.
 *
 * Covered, on each door an app uses:
 *   - `GET …/apps/:name/resources/*` (the shell fetching the view);
 *   - `POST …/resources/read` (a resource link the view's tool returned);
 *   - `/mcp/<wsId>` `resources/read` and `tools/call` scoped to the app, sent as
 *     the bridge sends them (`buildMcpRequest`).
 * A `my_` name reaches only the caller's own granted connection; a bare name
 * only the workspace's.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { buildMcpRequest, readMcpAnswer } from "../../web/src/mcp-bridge-client.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const UNGRANTED_WS = "ws_005820c54ca342ad";
const VIEW_URI = "ui://fixture/report";
const testDir = join(tmpdir(), `nb-personal-apps-${Date.now()}`);

/** A server with one app-callable tool and one view, each naming `owner`. */
function createFixtureServer(owner: string): Server {
  const server = new Server(
    { name: "fixture", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "ping",
        description: "Says whose connection answered",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { resourceUri: VIEW_URI, visibility: ["model", "app"] } },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: `pong from ${owner}` }],
  }));
  server.setRequestHandler("resources/list", async () => ({
    resources: [{ uri: VIEW_URI, name: "Report", mimeType: "text/html;profile=mcp-app" }],
  }));
  server.setRequestHandler("resources/read", async (request) => {
    if (request.params.uri !== VIEW_URI)
      throw new Error(`Resource not found: ${request.params.uri}`);
    return {
      contents: [
        { uri: VIEW_URI, mimeType: "text/html;profile=mcp-app", text: `<h1>${owner}</h1>` },
      ],
    };
  });
  return server;
}

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let workspaceServer: RemoteMcpFixture;
let personalServer: RemoteMcpFixture;
let workspaceSource: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    allowInsecureRemotes: true,
  });
  await provisionTestWorkspace(runtime);
  await provisionTestWorkspace(runtime, UNGRANTED_WS, "Ungranted");

  workspaceServer = startRemoteMcpServer(() => createFixtureServer("workspace"));
  workspaceSource = new McpSource(
    "fixture",
    { type: "remote", url: new URL(workspaceServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await workspaceSource.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(workspaceSource);

  personalServer = startRemoteMcpServer(() => createFixtureServer("personal"));
  await new IdentityConnectorStore({ workDir: testDir }).add(DEV_IDENTITY.id, {
    url: personalServer.url,
    serverName: "fixture",
    ui: null,
  });
  await runtime.getPermissionStore().grantConnector(DEV_IDENTITY.id, "fixture", TEST_WORKSPACE_ID);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
}, 30_000);

afterAll(async () => {
  handle?.stop(true);
  try {
    await workspaceSource?.stop();
  } catch {
    // already stopped
  }
  workspaceServer?.close();
  personalServer?.close();
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

function viewUrl(wsId: string, app: string): string {
  return `${baseUrl}/v1/workspaces/${wsId}/apps/${encodeURIComponent(app)}/resources/fixture/report`;
}

async function viewText(res: Response): Promise<string> {
  const body = (await res.json()) as { contents: Array<{ text?: string }> };
  return body.contents[0]?.text ?? "";
}

/** A request on `/mcp/<wsId>` exactly as the bridge sends it for app `app`. */
async function bridgeRequest(
  wsId: string,
  method: string,
  params: Record<string, unknown>,
  app: string,
): Promise<Awaited<ReturnType<typeof readMcpAnswer>>> {
  const { headers, body } = buildMcpRequest("1", method, {
    ...params,
    _meta: { [RESOURCE_SOURCE_META_KEY]: app },
  });
  const res = await fetch(`${baseUrl}/mcp/${wsId}`, { method: "POST", headers, body });
  return readMcpAnswer(res);
}

function resultText(answer: Awaited<ReturnType<typeof readMcpAnswer>>): string {
  if ("error" in answer) throw new Error(`unexpected error: ${answer.error.message}`);
  const result = answer.result as {
    content?: Array<{ text?: string }>;
    contents?: Array<{ text?: string }>;
  };
  return (result.content ?? result.contents)?.[0]?.text ?? "";
}

describe("GET …/apps/:name/resources/* — a personal app's view", () => {
  it("serves a granted personal app from the caller's own connection", async () => {
    const res = await fetch(viewUrl(TEST_WORKSPACE_ID, "my_fixture"));
    expect(res.status).toBe(200);
    expect(await viewText(res)).toBe("<h1>personal</h1>");
  });

  it("a bare name serves the workspace's app, never the personal one", async () => {
    const res = await fetch(viewUrl(TEST_WORKSPACE_ID, "fixture"));
    expect(res.status).toBe(200);
    expect(await viewText(res)).toBe("<h1>workspace</h1>");
  });

  it("an ungranted personal app answers exactly as an app the caller has none of", async () => {
    const ungranted = await fetch(viewUrl(UNGRANTED_WS, "my_fixture"));
    const absent = await fetch(viewUrl(UNGRANTED_WS, "my_nothing"));
    expect(ungranted.status).toBe(403);
    expect(absent.status).toBe(ungranted.status);
    const a = (await ungranted.json()) as { error: string };
    const b = (await absent.json()) as { error: string };
    expect(a.error).toBe("workspace_access_denied");
    expect(b.error).toBe(a.error);
  });
});

describe("POST …/resources/read — a personal app's resource", () => {
  async function read(wsId: string, server: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/workspaces/${wsId}/resources/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server, uri: VIEW_URI }),
    });
  }

  it("reads the granted personal connection for a `my_` server, the workspace's for a bare one", async () => {
    const personal = await read(TEST_WORKSPACE_ID, "my_fixture");
    expect(personal.status).toBe(200);
    expect(await viewText(personal)).toBe("<h1>personal</h1>");
    const workspace = await read(TEST_WORKSPACE_ID, "fixture");
    expect(await viewText(workspace)).toBe("<h1>workspace</h1>");
  });

  it("refuses an ungranted personal server", async () => {
    const res = await read(UNGRANTED_WS, "my_fixture");
    expect(res.status).toBe(403);
  });
});

describe("/mcp — the bridge's calls from a personal app", () => {
  it("a read scoped to the personal app reaches its own connection", async () => {
    const answer = await bridgeRequest(
      TEST_WORKSPACE_ID,
      "resources/read",
      { uri: VIEW_URI },
      "my_fixture",
    );
    expect(resultText(answer)).toBe("<h1>personal</h1>");
    const workspace = await bridgeRequest(
      TEST_WORKSPACE_ID,
      "resources/read",
      { uri: VIEW_URI },
      "fixture",
    );
    expect(resultText(workspace)).toBe("<h1>workspace</h1>");
  });

  it("a read scoped to an ungranted personal app answers not found", async () => {
    const answer = await bridgeRequest(
      UNGRANTED_WS,
      "resources/read",
      { uri: VIEW_URI },
      "my_fixture",
    );
    expect("error" in answer && answer.error.code).toBe(-32602);
  });

  it("a personal app's tools/call runs on the personal connection", async () => {
    const answer = await bridgeRequest(
      TEST_WORKSPACE_ID,
      "tools/call",
      { name: "my_fixture__ping", arguments: {} },
      "my_fixture",
    );
    expect(resultText(answer)).toBe("pong from personal");
  });

  it("a personal app cannot call the workspace's tool of the same server, nor the reverse", async () => {
    const fromPersonal = await bridgeRequest(
      TEST_WORKSPACE_ID,
      "tools/call",
      { name: "fixture__ping", arguments: {} },
      "my_fixture",
    );
    expect("error" in fromPersonal && fromPersonal.error.data).toMatchObject({
      reason: "outside_app_scope",
    });
    const fromWorkspace = await bridgeRequest(
      TEST_WORKSPACE_ID,
      "tools/call",
      { name: "my_fixture__ping", arguments: {} },
      "fixture",
    );
    expect("error" in fromWorkspace && fromWorkspace.error.data).toMatchObject({
      reason: "outside_app_scope",
    });
    const workspaceOwn = await bridgeRequest(
      TEST_WORKSPACE_ID,
      "tools/call",
      { name: "fixture__ping", arguments: {} },
      "fixture",
    );
    expect(resultText(workspaceOwn)).toBe("pong from workspace");
  });
});
