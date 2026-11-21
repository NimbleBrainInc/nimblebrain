/**
 * A server in development, added to a local install by URL (ADR-0065), end
 * to end: a real Streamable HTTP MCP server on loopback with no auth and a
 * Server Card, a runtime with the local-install gate on (`NB_HOST_LOOPBACK`
 * and the `dev` adapter in `instance.json`), and the install made through the
 * REST tool-call door the CLI and the web shell use.
 *
 * The alias is `127.0.0.1` and the stored URL names `localhost`, so every
 * request the server sees proves the dial went through the alias while keeping
 * the stored URL's `Host`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { _resetHostLoopbackForTest } from "../../src/connectors/runtime/host-loopback.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { writeInstanceConfig } from "../helpers/instance-config.ts";

const testDir = join(tmpdir(), `nb-direct-url-install-${Date.now()}`);
const SERVER_NAME = "io-github-dev-forecast";

const CARD = {
  name: "io.github.dev/forecast",
  title: "Forecast (card)",
  description: "Forecasts, in development",
  icons: [{ src: "data:image/svg+xml;base64,PHN2Zy8+" }],
  _meta: {
    "ai.nimblebrain/host": {
      hostVersion: "1.5",
      placements: [
        {
          slot: "sidebar.apps",
          resourceUri: "ui://forecast/main",
          label: "Forecast",
          route: "forecast",
        },
      ],
      adminTools: ["forecast"],
    },
  },
};

/** The `Host` header of every request the MCP server received. */
const hostsSeen: string[] = [];
let mcpServer: ReturnType<typeof Bun.serve>;
let serverUrl: string;

function createForecastServer(): Server {
  const server = new Server(
    { name: "io.github.dev/forecast", title: "Forecast Live", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "forecast",
        description: "Tomorrow's forecast",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: "sunny" }],
  }));
  return server;
}

/** A Streamable HTTP MCP server with no auth, serving its card at `/mcp/server-card`. */
function startForecastServer(): ReturnType<typeof Bun.serve> {
  let counter = 0;
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      hostsSeen.push(req.headers.get("host") ?? "");
      const url = new URL(req.url);
      if (url.pathname === "/mcp/server-card" && req.method === "GET") {
        return Response.json(CARD, {
          headers: { "content-type": "application/mcp-server-card+json" },
        });
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const existing = transports.get(sid);
        if (existing) return existing.handleRequest(req);
        return new Response("Session not found", { status: 404 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => `sess-${++counter}`,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      await createForecastServer().connect(transport);
      return transport.handleRequest(req);
    },
  });
}

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let wsId: string;
let savedLoopback: string | undefined;

async function bootRuntime(): Promise<void> {
  runtime = await Runtime.start({
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

async function stopRuntime(): Promise<void> {
  handle.stop(true);
  stopAllToolSurfaceWatches();
  await runtime.shutdown();
}

async function manage(args: Record<string, unknown>): Promise<ToolCallResponse> {
  const res = await fetch(`${baseUrl}/v1/workspaces/${wsId}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "nb", tool: "manage_connectors", arguments: args }),
  });
  expect(res.status).toBe(200);
  return readJson<ToolCallResponse>(res);
}

async function storedRows(): Promise<ConnectorRef[]> {
  return (await runtime.getWorkspaceStore().get(wsId))?.connectors ?? [];
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  await writeInstanceConfig(testDir, { auth: { adapter: "dev" } });
  savedLoopback = process.env.NB_HOST_LOOPBACK;
  process.env.NB_HOST_LOOPBACK = "127.0.0.1";
  mcpServer = startForecastServer();
  serverUrl = `http://localhost:${mcpServer.port}/mcp`;
  await bootRuntime();
  wsId = (await runtime.getWorkspaceStore().create("Dev")).id;
  await runtime.getWorkspaceStore().addMember(wsId, DEV_IDENTITY.id, "admin");
  await runtime.ensureWorkspaceRegistry(wsId);
});

afterAll(async () => {
  await stopRuntime();
  mcpServer.stop(true);
  if (savedLoopback === undefined) delete process.env.NB_HOST_LOOPBACK;
  else process.env.NB_HOST_LOOPBACK = savedLoopback;
  _resetHostLoopbackForTest();
  rmSync(testDir, { recursive: true, force: true });
});

describe("direct-url install on a local install", () => {
  it("the gate holds: dev adapter and NB_HOST_LOOPBACK", () => {
    expect(runtime.getHostLoopback()).toBe("127.0.0.1");
    expect(runtime.getAllowInsecureRemotes()).toBe(true);
  });

  it("installs a no-auth server by URL and connects it with no credential", async () => {
    const result = await manage({
      action: "install",
      entry: { id: "direct-url", name: serverUrl, install: { kind: "direct-url", url: serverUrl } },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      serverName: SERVER_NAME,
      url: serverUrl,
      dialed: `http://127.0.0.1:${mcpServer.port}/mcp`,
      wsId,
      placements: [
        {
          slot: "sidebar.apps",
          resourceUri: "ui://forecast/main",
          label: "Forecast",
          route: "forecast",
        },
      ],
    });
    expect((result.structuredContent as { warning?: string }).warning).toBeUndefined();

    // Every request was dialed at the alias and kept the stored URL's Host.
    expect(hostsSeen.length).toBeGreaterThan(1);
    expect(new Set(hostsSeen)).toEqual(new Set([`localhost:${mcpServer.port}`]));

    const [row] = await storedRows();
    expect(row?.url).toBe(serverUrl);
    expect(row?.transport).toEqual({ type: "streamable-http", auth: { type: "none" } });
    expect(JSON.stringify(row)).not.toContain("adminTools");

    // No credential was stored for it.
    const keys = await runtime.getCredentialStore().list({ kind: "workspace", wsId });
    expect(keys.filter((k) => k.key.includes(SERVER_NAME))).toEqual([]);
  });

  it("lists its tools", async () => {
    const result = await manage({ action: "list_tools", serverName: SERVER_NAME });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.structuredContent)).toContain("forecast");
  });

  it("shows the live title over the card's, and the card's icon", async () => {
    const result = await manage({ action: "get_installed", serverName: SERVER_NAME });
    const installed = (result.structuredContent as { installed: Record<string, unknown> | null })
      .installed;
    expect(installed).toMatchObject({
      serverName: SERVER_NAME,
      displayName: "Forecast Live",
      iconUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      state: "running",
      interactive: true,
      toolCount: 1,
    });
  });

  it("keeps its placements and reconnects across a restart", async () => {
    await stopRuntime();
    hostsSeen.length = 0;
    await bootRuntime();
    const instance = runtime.getLifecycle().getInstance(SERVER_NAME, wsId);
    expect(instance?.ui?.placements).toEqual([
      {
        slot: "sidebar.apps",
        resourceUri: "ui://forecast/main",
        label: "Forecast",
        route: "forecast",
      },
    ]);
    const tools = await manage({ action: "list_tools", serverName: SERVER_NAME });
    expect(JSON.stringify(tools.structuredContent)).toContain("forecast");
    expect(new Set(hostsSeen)).toEqual(new Set([`localhost:${mcpServer.port}`]));
  });

  it("uninstalls cleanly", async () => {
    const result = await manage({ action: "uninstall", serverName: SERVER_NAME });
    expect(result.isError).toBe(false);
    expect(await storedRows()).toEqual([]);
    expect(runtime.getLifecycle().getInstance(SERVER_NAME, wsId)).toBeUndefined();
    expect(runtime.getRegistryForWorkspace(wsId).hasSource(SERVER_NAME)).toBe(false);
  });
});
