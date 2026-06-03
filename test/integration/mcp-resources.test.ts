import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Fixture: stdio MCP server with two resources
//
// Exposes one tool (so tools/list is still populated) plus:
//   - ui://fixture/dashboard         → text/html payload
//   - text://fixture/greeting         → plain-text payload
// ---------------------------------------------------------------------------
const FIXTURE_HTML = "<h1>Fixture Dashboard</h1><p>hello from a test resource</p>";
const FIXTURE_TEXT = "hello greetings from fixture";

interface FixtureConfig {
  namespace: string;
  htmlBody: string;
  textBody: string;
}

function createFixtureBundle(dir: string, config: FixtureConfig): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const dashboardUri = `ui://${config.namespace}/dashboard`;
  const greetingUri = `text://${config.namespace}/greeting`;
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: ${JSON.stringify(config.namespace)}, version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping",
        description: "Returns pong",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: ${JSON.stringify(dashboardUri)}, name: "Dashboard", mimeType: "text/html" },
      { uri: ${JSON.stringify(greetingUri)}, name: "Greeting", mimeType: "text/plain" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === ${JSON.stringify(dashboardUri)}) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/html",
            text: ${JSON.stringify(config.htmlBody)},
          },
        ],
      };
    }
    if (request.params.uri === ${JSON.stringify(greetingUri)}) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/plain",
            text: ${JSON.stringify(config.textBody)},
          },
        ],
      };
    }
    throw new Error("Resource not found: " + request.params.uri);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(dir, "server.cjs"), serverCode);
  return dir;
}

// ---------------------------------------------------------------------------
// Shared harness: one runtime, one server, two workspaces with different sources.
// ---------------------------------------------------------------------------
const OTHER_WORKSPACE_ID = "ws_other";
const testDir = join(tmpdir(), `nimblebrain-mcp-resources-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let fixtureSource: McpSource;
let otherSource: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });

  // Provision the primary workspace and register the fixture MCP source in it.
  await provisionTestWorkspace(runtime);
  const fixtureDir = createFixtureBundle(join(testDir, "fixture"), {
    namespace: "fixture",
    htmlBody: FIXTURE_HTML,
    textBody: FIXTURE_TEXT,
  });
  fixtureSource = new McpSource(
    "fixture",
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(fixtureDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
    new NoopEventSink(),
  );
  await fixtureSource.start();
  const primaryReg = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  primaryReg.addSource(fixtureSource);

  // Provision a second workspace with its own MCP source and a distinct
  // namespace — `ui://other/dashboard` is only reachable from this workspace.
  await provisionTestWorkspace(runtime, OTHER_WORKSPACE_ID, "Other Workspace");
  const otherDir = createFixtureBundle(join(testDir, "other"), {
    namespace: "other",
    htmlBody: "<h1>Other Workspace</h1>",
    textBody: "other greetings",
  });
  otherSource = new McpSource(
    "other",
    {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(otherDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    },
    new NoopEventSink(),
  );
  await otherSource.start();
  const otherReg = runtime.getRegistryForWorkspace(OTHER_WORKSPACE_ID);
  otherReg.addSource(otherSource);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
  // Generous hook timeout: this setup starts a Runtime, provisions two
  // workspaces, and spawns two Node MCP subprocesses. The 5s default hook
  // timeout is too tight under CI load and flaked on subprocess spawn
  // ("killed 1 dangling process"). 30s leaves ample headroom without
  // masking a genuine hang.
}, 30_000);

afterAll(async () => {
  // Optional-chain every teardown step: if `beforeAll` timed out partway,
  // these vars may be unassigned. Without the guards a setup flake surfaces
  // as a misleading `TypeError: undefined is not an object` from teardown,
  // burying the real cause (the spawn timeout).
  handle?.stop(true);
  try {
    await fixtureSource?.stop();
  } catch {
    // already stopped
  }
  try {
    await otherSource?.stop();
  } catch {
    // already stopped
  }
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

async function createMcpClient(workspaceId: string = TEST_WORKSPACE_ID): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: { "x-workspace-id": workspaceId },
    },
  });
  const client = new Client({ name: "mcp-resources-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("MCP /mcp — resources", () => {
  it("advertises the resources capability in InitializeResult", async () => {
    const client = await createMcpClient();
    try {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      // `resources` must be present (value may be `{}` — presence is what matters).
      expect(caps?.resources).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("resources/list returns resources from every source the identity can access", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain("ui://fixture/dashboard");
      expect(uris).toContain("text://fixture/greeting");
      // Stage 2: sessions are identity-bound; the identity is also a
      // member of the "other" workspace, so its resources appear here.
      expect(uris).toContain("ui://other/dashboard");
    } finally {
      await client.close();
    }
  });

  it("resources/read on a known URI returns the resource's bytes", async () => {
    // Parity acceptance criterion: /mcp's `resources/read` must return the
    // same shape as `POST /v1/resources/read` — `{ contents: [{ uri,
    // mimeType?, text?, blob? }] }` — with identical bytes for a given URI.
    //
    // We can't exercise the legacy REST endpoint directly here because it
    // goes through `Runtime.readAppResource`, which checks bundle lifecycle
    // state (`lifecycle.getInstance`) and returns null for sources added
    // straight to the registry. We still assert the canonical spec shape
    // and the round-trip bytes, which is what parity means in practice.
    const client = await createMcpClient();
    try {
      const mcpResult = await client.readResource({ uri: "ui://fixture/dashboard" });
      expect(mcpResult.contents).toHaveLength(1);
      const mcpEntry = mcpResult.contents[0]!;
      expect(mcpEntry.uri).toBe("ui://fixture/dashboard");
      expect(mcpEntry.mimeType).toBe("text/html");
      expect(mcpEntry.text).toBe(FIXTURE_HTML);

      // A second URI on the same source, different mimeType, same shape.
      const textResult = await client.readResource({ uri: "text://fixture/greeting" });
      expect(textResult.contents).toHaveLength(1);
      expect(textResult.contents[0]!.text).toBe(FIXTURE_TEXT);
      expect(textResult.contents[0]!.mimeType).toBe("text/plain");
    } finally {
      await client.close();
    }
  });

  it("resources/read on an unknown URI returns a JSON-RPC error (not 500)", async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.readResource({ uri: "ui://fixture/does-not-exist" }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await client.close();
    }

    // Drive the request at the raw HTTP layer too to confirm the transport
    // surfaces a JSON-RPC `error` envelope with code -32002 instead of a 500.
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": TEST_WORKSPACE_ID,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // The SDK requires an `initialized` notification before further requests.
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": TEST_WORKSPACE_ID,
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    const readRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-workspace-id": TEST_WORKSPACE_ID,
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "ui://fixture/does-not-exist" },
      }),
    });
    // Transport returns 200 with an error envelope (not 500).
    expect(readRes.status).toBe(200);
    const raw = await readRes.text();
    const payload = parseJsonOrSsePayload(raw);
    expect(payload.error).toBeDefined();
    expect(payload.error?.code).toBe(-32002);
  });

  it("identity-bound session: resources aggregate across every workspace the identity can access (Stage 2)", async () => {
    // Stage 2 (Q4 hard cut): `/mcp` sessions are identity-bound. A
    // single session sees every workspace's resources the identity
    // belongs to, not just the one the `X-Workspace-Id` header
    // (which is now ignored) points at. The dev identity is a member
    // of both `TEST_WORKSPACE_ID` and `OTHER_WORKSPACE_ID`, so both
    // workspaces' resources show up in the same `resources/list`.
    const client = await createMcpClient(TEST_WORKSPACE_ID);
    try {
      const list = await client.listResources();
      const uris = list.resources.map((r) => r.uri);
      expect(uris).toContain("ui://fixture/dashboard");
      expect(uris).toContain("ui://other/dashboard");

      // resources/read also resolves across workspaces.
      const own = await client.readResource({ uri: "ui://fixture/dashboard" });
      expect(own.contents[0]!.text).toBe(FIXTURE_HTML);
      const other = await client.readResource({ uri: "ui://other/dashboard" });
      expect(other.contents[0]!.text).toBe("<h1>Other Workspace</h1>");
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The streamable-HTTP transport may return either a JSON body or an SSE
 * stream for a single JSON-RPC response. Parse both.
 */
function parseJsonOrSsePayload(raw: string): {
  error?: { code: number; message: string };
  result?: unknown;
} {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as { error?: { code: number; message: string } };
  }
  // SSE: find the data: lines.
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice(5).trim()) as {
        error?: { code: number; message: string };
      };
    }
  }
  throw new Error(`Unexpected response body: ${raw}`);
}
