/**
 * MCP Apps tool visibility (`_meta.ui.visibility`) on `/mcp`, for a connector
 * reached over a real HTTP wire.
 *
 * The spec binds a host twice: a tool without `"model"` is left out of an
 * agent's tool list and refused to an agent's call, and an app's `tools/call`
 * is refused for a tool without `"app"`. A call is an app's when a first-party
 * credential names a source under `RESOURCE_SOURCE_META_KEY`, which is how the
 * iframe bridge sends every call a view makes; it is then also held to that
 * one server. A token issued to an external MCP client makes an agent's call,
 * whatever it names.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { mcpResourceUrl } from "../../src/api/mcp-resource.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import type { VerifiedIdentity } from "../../src/identity/provider.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { IdentityStores } from "../../src/runtime/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { surfaceTools } from "../../src/tools/surfacing.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** A third-party server declaring each visibility the spec allows. */
function createVisibilityServer(): Server {
  const server = new Server({ name: "vis", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "refresh",
        description: "Refresh the dashboard (a view's button)",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "summarize",
        description: "Summarize the dashboard for the agent",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      },
      {
        name: "ping",
        description: "Returns pong",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async (request) => ({
    content: [{ type: "text", text: `ran ${request.params.name}` }],
  }));
  return server;
}

/** A second server in the same workspace, outside the `vis` app's scope. */
function createNeighborServer(): Server {
  const server = new Server(
    { name: "neighbor", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "ping",
        description: "Returns pong",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

/** The bearer an external MCP client presents: a token the authorization server minted for this workspace's `/mcp`. */
const MCP_CLIENT_TOKEN = "external-mcp-client";

/**
 * The dev user, with the grant the credential carries: a resource grant for
 * {@link MCP_CLIENT_TOKEN} (an external MCP client, such as an outside agent),
 * first-party for anything else (the web shell and its bridge).
 */
class GrantingDevProvider extends DevIdentityProvider {
  override async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    const verified = await super.verifyRequest(req);
    if (!verified || req.headers.get("authorization") !== `Bearer ${MCP_CLIENT_TOKEN}`) {
      return verified;
    }
    return {
      ...verified,
      grant: { kind: "resource", audience: [mcpResourceUrl(TEST_WORKSPACE_ID)] },
    };
  }
}

const testDir = join(tmpdir(), `nimblebrain-mcp-tool-visibility-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let visServer: RemoteMcpFixture;
let neighborServer: RemoteMcpFixture;
let visSource: McpSource;
let neighborSource: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: ({ workDir, userStore }: IdentityStores) =>
      new GrantingDevProvider(workDir, userStore),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

  visServer = startRemoteMcpServer(createVisibilityServer);
  visSource = new McpSource(
    "vis",
    { type: "remote", url: new URL(visServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await visSource.start();
  registry.addSource(visSource);

  neighborServer = startRemoteMcpServer(createNeighborServer);
  neighborSource = new McpSource(
    "neighbor",
    { type: "remote", url: new URL(neighborServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await neighborSource.start();
  registry.addSource(neighborSource);

  // A source that cannot list its tools (not connected), so an agent's call
  // cannot read the visibility of any tool it routes to.
  registry.addSource({
    name: "down",
    start: async () => {},
    stop: async () => {},
    tools: async () => {
      throw new Error('McpSource "down" not started');
    },
    execute: async () => ({ content: [{ type: "text", text: "ran" }], isError: false }),
  });

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
}, 30_000);

afterAll(async () => {
  handle?.stop(true);
  try {
    await visSource?.stop();
  } catch {
    // already stopped
  }
  try {
    await neighborSource?.stop();
  } catch {
    // already stopped
  }
  visServer?.close();
  neighborServer?.close();
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

/** An MCP client on the web shell's first-party session, or as an external client when `external`. */
async function createMcpClient(external = false): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`),
    external
      ? { requestInit: { headers: { Authorization: `Bearer ${MCP_CLIENT_TOKEN}` } } }
      : undefined,
  );
  const client = new Client({ name: "mcp-tool-visibility-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function firstText(result: { content?: unknown }): string | undefined {
  return (result.content as Array<{ text?: string }> | undefined)?.[0]?.text;
}

describe("MCP Apps tool visibility — agent tool lists", () => {
  it('the /mcp tools/list leaves out a tool without "model"', async () => {
    const client = await createMcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("vis__refresh");
      expect(names).toContain("vis__summarize");
      expect(names).toContain("vis__ping");
    } finally {
      await client.close();
    }
  });

  it("the chat surface leaves it out too", async () => {
    const all = await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID);
    expect(all.map((t) => t.name)).toContain("vis__refresh");
    const { direct, proxied } = surfaceTools(all, null);
    const surfaced = [...direct, ...proxied].map((t) => t.name);
    expect(surfaced).not.toContain("vis__refresh");
    expect(surfaced).toContain("vis__summarize");
  });
});

describe("MCP Apps tool visibility — an agent's tools/call", () => {
  it("refuses an app-only tool when the call names no source", async () => {
    const client = await createMcpClient();
    try {
      await expect(client.callTool({ name: "vis__refresh", arguments: {} })).rejects.toThrow(
        /not callable by an agent/,
      );
    } finally {
      await client.close();
    }
  });

  it("refuses an app-only tool to an external client that names no source", async () => {
    const client = await createMcpClient(true);
    try {
      await expect(client.callTool({ name: "vis__refresh", arguments: {} })).rejects.toThrow(
        /not callable by an agent/,
      );
    } finally {
      await client.close();
    }
  });

  it("refuses an app-only tool to an external client that names the tool's own source", async () => {
    const client = await createMcpClient(true);
    try {
      await expect(
        client.callTool({
          name: "vis__refresh",
          arguments: {},
          _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
        }),
      ).rejects.toThrow(/not callable by an agent/);
    } finally {
      await client.close();
    }
  });

  it("lets an external client call model-visible tools, with or without a source", async () => {
    const client = await createMcpClient(true);
    try {
      expect(
        (await client.callTool({ name: "vis__summarize", arguments: {} })).isError,
      ).toBeFalsy();
      expect((await client.callTool({ name: "vis__ping", arguments: {} })).isError).toBeFalsy();
      const scoped = await client.callTool({
        name: "vis__ping",
        arguments: {},
        _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
      });
      expect(scoped.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("asks for a retry when the source cannot list its tools", async () => {
    const client = await createMcpClient(true);
    try {
      await expect(client.callTool({ name: "down__anything", arguments: {} })).rejects.toThrow(
        /its server is not connected.*Retry/,
      );
    } finally {
      await client.close();
    }
  });

  it("refuses a tool its server does not list", async () => {
    const client = await createMcpClient(true);
    try {
      await expect(client.callTool({ name: "vis__nonexistent", arguments: {} })).rejects.toThrow(
        /not callable by an agent/,
      );
    } finally {
      await client.close();
    }
  });
});

describe("MCP Apps tool visibility — the session's grant", () => {
  it("turns an external client away from a first-party session", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`),
    );
    const client = new Client({ name: "mcp-tool-visibility-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();
      const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${MCP_CLIENT_TOKEN}`,
          "Mcp-Session-Id": sessionId ?? "",
          "Mcp-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "vis__refresh",
            arguments: {},
            _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
          },
        }),
      });
      expect(res.status).toBe(404);
    } finally {
      await client.close();
    }
  });
});

describe("MCP Apps tool visibility — REST tools/call", () => {
  async function restCall(tool: string, bearer?: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ server: "vis", tool, arguments: {} }),
    });
  }

  it("admits no external client's credential, so it cannot reach an app-only tool", async () => {
    const res = await restCall("refresh", MCP_CLIENT_TOKEN);
    expect(res.status).toBe(401);
  });

  it("serves the web shell's first-party session", async () => {
    const res = await restCall("refresh");
    expect(res.status).toBe(200);
  });
});

describe("MCP Apps tool visibility — an app's tools/call", () => {
  it("reaches an app-only tool of its own server", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: "vis__refresh",
        arguments: {},
        _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe("ran refresh");
    } finally {
      await client.close();
    }
  });

  it("reaches a tool with the default visibility", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: "vis__ping",
        arguments: {},
        _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('is refused for a tool without "app"', async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.callTool({
          name: "vis__summarize",
          arguments: {},
          _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
        }),
      ).rejects.toThrow(/not callable from an app/);
    } finally {
      await client.close();
    }
  });

  it("is refused for a tool its server does not list", async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.callTool({
          name: "vis__nonexistent",
          arguments: {},
          _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
        }),
      ).rejects.toThrow(/it is not listed/);
    } finally {
      await client.close();
    }
  });

  it("is refused for another server's tool", async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.callTool({
          name: "neighbor__ping",
          arguments: {},
          _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
        }),
      ).rejects.toThrow(/scoped to that server/);
    } finally {
      await client.close();
    }
  });

  it("an agent's call (no source named) reaches a model-only tool", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: "vis__summarize", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
