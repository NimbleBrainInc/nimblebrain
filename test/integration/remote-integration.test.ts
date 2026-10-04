import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { getConnectorRefValidator } from "../../src/config/index.ts";
import { startConnectorSource } from "../../src/connectors/runtime/startup.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `nimblebrain-remote-integ-${Date.now()}`);

function ensureTestDir() {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
}

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

interface MockRemoteServer {
  url: string;
  port: number;
  close: () => void;
}

function createMcpServer(toolCount: number): Server {
  const mcpServer = new Server(
    { name: "integ-echo", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const tools = Array.from({ length: toolCount }, (_, i) => ({
    name: `integ_tool_${i}`,
    description: `Integration test tool ${i}`,
    inputSchema: {
      type: "object" as const,
      properties: { input: { type: "string" } },
    },
  }));

  mcpServer.setRequestHandler("tools/list", async () => ({ tools }));
  mcpServer.setRequestHandler("tools/call", async (req) => ({
    content: [{ type: "text", text: `Executed: ${req.params.name}` }],
  }));

  return mcpServer;
}

function startMockRemoteServer(toolCount = 2): MockRemoteServer {
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const servers: Server[] = [];

  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      const mcpServer = createMcpServer(toolCount);
      servers.push(mcpServer);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      transports.push(transport);

      await mcpServer.connect(transport);
      return transport.handleRequest(req);
    },
  });

  return {
    url: `http://localhost:${httpServer.port}/mcp`,
    port: httpServer.port,
    close() {
      httpServer.stop(true);
      for (const t of transports) t.close().catch(() => {});
      for (const s of servers) s.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Config parsing → schema validation → source creation (full pipeline)
// ---------------------------------------------------------------------------

describe("Remote integration: config → validate → load → tools", () => {
  let mockServer: MockRemoteServer;

  beforeEach(() => {
    ensureTestDir();
    // This block drives `startConnectorSource` without a Runtime, so nothing has
    // installed the store the OAuth provider reads its records through.
    installTestCredentialStore(testDir);
    mockServer = startMockRemoteServer(3);
  });

  afterEach(() => {
    resetTestCredentialStore();
    mockServer?.close();
  });

  it("config with url entry passes schema validation and starts a working source", async () => {
    // Step 1: Build a config object with a url connector
    const entry = {
      url: mockServer.url,
      serverName: "validated-remote",
    };

    // Step 2: Validate against JSON Schema (the published connector-ref shape)
    const validate = getConnectorRefValidator();
    expect(validate(entry)).toBe(true);

    // Step 3: Start connector source from the validated ref
    const registry = new ToolRegistry();
    const ref: ConnectorRef = entry as ConnectorRef;
    const meta = await startConnectorSource(ref, registry, new NoopEventSink(), {
      allowInsecureRemotes: true,
      wsId: "ws_0076759dbbe19fcc",
    });

    expect(meta).not.toBeNull();
    expect(meta.meta).not.toBeNull();
    expect(meta.meta!.version).toBe("remote");
    expect(registry.hasSource("validated-remote")).toBe(true);

    // Step 4: Verify tools are actually callable
    const tools = await registry.availableTools();
    expect(tools.length).toBe(3);
    expect(tools[0]!.name).toContain("integ_tool_");

    await registry.removeSource("validated-remote");
  }, 15_000);

  it("config with url + transport + auth validates and source starts", async () => {
    const entry = {
      url: mockServer.url,
      serverName: "authed-remote",
      transport: {
        type: "streamable-http",
        auth: { type: "bearer", token: "test-token-123" },
        headers: { "X-Custom": "value" },
      },
    };

    // Schema validation
    const validate = getConnectorRefValidator();
    expect(validate(entry)).toBe(true);

    // Start source (auth headers won't affect our mock server)
    const registry = new ToolRegistry();
    const ref: ConnectorRef = entry as ConnectorRef;
    const meta = await startConnectorSource(ref, registry, new NoopEventSink(), {
      allowInsecureRemotes: true,
      wsId: "ws_0076759dbbe19fcc",
    });

    expect(meta).not.toBeNull();
    expect(registry.hasSource("authed-remote")).toBe(true);

    await registry.removeSource("authed-remote");
  }, 15_000);

  it("config with url entry that fails connection does not leave orphan in registry", async () => {
    const entry = {
      url: "http://127.0.0.1:1/mcp",
      serverName: "dead-remote",
    };

    const validate = getConnectorRefValidator();
    expect(validate(entry)).toBe(true);

    const registry = new ToolRegistry();
    const ref: ConnectorRef = entry as ConnectorRef;

    const results = await Promise.allSettled([
      startConnectorSource(ref, registry, new NoopEventSink(), {
        allowInsecureRemotes: true,
        wsId: "ws_0076759dbbe19fcc",
      }),
    ]);
    expect(results[0]!.status).toBe("rejected");
    expect(registry.hasSource("dead-remote")).toBe(false);
  }, 20_000);

  it("keepRegisteredOnStartFailure leaves an unreachable url connector registered and retryable", async () => {
    // The boot-loop contract. An installed connector whose endpoint is unreachable
    // during startup must stay in the registry: an absent source is invisible to
    // the agent's tool list, `nb__status`, HealthMonitor, and the unhealthy
    // gauge — and the only path that revives it needs a tool call the model
    // cannot make against a tool it was never shown.
    const registry = new ToolRegistry();
    const ref: ConnectorRef = { url: "http://127.0.0.1:1/mcp", serverName: "boot-down-remote" };

    const results = await Promise.allSettled([
      startConnectorSource(ref, registry, new NoopEventSink(), {
        allowInsecureRemotes: true,
        wsId: "ws_0076759dbbe19fcc",
        keepRegisteredOnStartFailure: true,
      }),
    ]);

    // The caller still learns the start failed — this changes registry
    // retention, not the reported outcome.
    expect(results[0]!.status).toBe("rejected");
    expect(registry.hasSource("boot-down-remote")).toBe(true);

    const source = registry.getSource("boot-down-remote") as McpSource;
    // Down, but NOT deliberately stopped. `isStopped()` is what HealthMonitor
    // reads to mark a source terminal, and `removeSource` would have set it via
    // stop() — so this assertion is the one that proves the source will actually
    // be reconnected rather than merely being visible.
    expect(source.isAlive()).toBe(false);
    expect(source.isStopped()).toBe(false);

    await registry.removeSource("boot-down-remote");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 2. Mixed config startup: name + path + url via Runtime.start
// ---------------------------------------------------------------------------

describe("Remote integration: registering remote connectors in workspace registry", () => {
  let mockServer: MockRemoteServer;

  beforeEach(() => {
    ensureTestDir();
    mockServer = startMockRemoteServer(2);
  });

  afterEach(() => {
    mockServer?.close();
  });

  it("remote connector can be registered into a workspace registry and provides tools", async () => {
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir: testDir,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      allowInsecureRemotes: true,
    });
    await provisionTestWorkspace(runtime);

    // Register a remote connector into the workspace registry
    const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
    const ref: ConnectorRef = { url: mockServer.url, serverName: "runtime-remote" };
    await startConnectorSource(ref, registry, new NoopEventSink(), {
      allowInsecureRemotes: true,
      wsId: "ws_0076759dbbe19fcc",
    });

    expect(registry.hasSource("runtime-remote")).toBe(true);

    // Verify tools are available via the registry
    const tools = await registry.availableTools();
    const remoteTools = tools.filter((t) => t.name.includes("integ_tool_"));
    expect(remoteTools.length).toBe(2);

    await registry.removeSource("runtime-remote");
    await runtime.shutdown();
  }, 15_000);

  it("failed remote connector does not pollute registry while successful one registers", async () => {
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir: testDir,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      allowInsecureRemotes: true,
    });
    await provisionTestWorkspace(runtime);

    const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

    // Try to register a bad remote (should fail)
    const badRef: ConnectorRef = { url: "http://127.0.0.1:1/mcp", serverName: "bad-remote" };
    const badResult = await Promise.allSettled([
      startConnectorSource(badRef, registry, new NoopEventSink(), {
        allowInsecureRemotes: true,
        wsId: "ws_0076759dbbe19fcc",
      }),
    ]);
    expect(badResult[0]!.status).toBe("rejected");
    expect(registry.hasSource("bad-remote")).toBe(false);

    // Register a good remote (should succeed)
    const goodRef: ConnectorRef = { url: mockServer.url, serverName: "good-remote" };
    await startConnectorSource(goodRef, registry, new NoopEventSink(), {
      allowInsecureRemotes: true,
      wsId: "ws_0076759dbbe19fcc",
    });
    expect(registry.hasSource("good-remote")).toBe(true);

    await registry.removeSource("good-remote");
    await runtime.shutdown();
  }, 25_000);
});
