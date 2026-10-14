import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { JsonRpcErrorBody } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { log } from "../../src/observability/log.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { MCP_PROTOCOL_VERSION, newMcpClient } from "../helpers/mcp-client.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------
//
// The session-miss tests below assert on log content, not just status codes.
// The whole reason these logs exist is to make session-miss diagnoseable
// in production — if a future refactor silently drops the `log.warn` calls,
// status codes alone wouldn't catch it. Capturing also keeps stderr clean of
// the yellow `[mcp] session miss` lines that the tests deliberately provoke.
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { warn: log.warn, info: log.info };
  log.warn = (msg: string) => lines.push(`warn ${msg}`);
  log.info = (msg: string) => lines.push(`info ${msg}`);
  return {
    lines,
    restore: () => {
      log.warn = orig.warn;
      log.info = orig.info;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake tool source for testing
// ---------------------------------------------------------------------------
class FakeToolSource implements ToolSource {
  readonly name = "fake";

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async tools(): Promise<Tool[]> {
    return [
      {
        name: "fake__echo",
        description: "Echoes input back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        source: "inline",
      },
    ];
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (toolName === "echo") {
      return { content: textContent(String(input.text)), isError: false };
    }
    return { content: textContent(`Unknown tool: ${toolName}`), isError: true };
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-mcp-endpoint-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);

  // Register a fake tool source so we have tools to list/call.
  const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  wsRegistry.addSource(new FakeToolSource());

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Helper: create an MCP client connected to the /mcp endpoint
// ---------------------------------------------------------------------------
async function createMcpClient(opts: { headers?: Record<string, string> } = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`),
    {
      requestInit: {
        headers: {
          ...(opts.headers ?? {}),
        },
      },
    },
  );
  const client = newMcpClient({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("MCP Server Endpoint (/mcp)", () => {
  it("client connects and lists tools", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listTools();
      expect(result.tools.length).toBeGreaterThan(0);

      const expectedName = "fake__echo";
      const echoTool = result.tools.find((t) => t.name === expectedName);
      expect(echoTool).toBeDefined();
      expect(echoTool!.description).toBe("Echoes input back");
    } finally {
      await client.close();
    }
  });

  it("client calls a tool", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: "fake__echo",
        arguments: { text: "hello world" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    } finally {
      await client.close();
    }
  });

  it("tool call with unknown tool is refused", async () => {
    const client = await createMcpClient();
    try {
      // A valid source with a bad tool name: the source resolves, and the
      // agent-call visibility check refuses a tool its listing does not name.
      await expect(client.callTool({ name: "fake__nonexistent", arguments: {} })).rejects.toThrow(
        /it is not listed/,
      );
    } finally {
      await client.close();
    }
  });

  it("multiple clients can connect simultaneously", async () => {
    const client1 = await createMcpClient();
    const client2 = await createMcpClient();
    try {
      const [result1, result2] = await Promise.all([client1.listTools(), client2.listTools()]);
      expect(result1.tools.length).toBeGreaterThan(0);
      expect(result2.tools.length).toBeGreaterThan(0);
    } finally {
      await Promise.all([client1.close(), client2.close()]);
    }
  });

  // `McpServerHost.handle` leaves GET and DELETE to the SDK, which answers 405:
  // GET would open a standalone server→client stream, which the door does not
  // serve, and DELETE would end a session, which the door does not have.
  it("returns 405 for GET and DELETE: there is no standalone stream and no session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method,
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
      await res.body?.cancel();
    }
  });

  it("refuses a 2025-era request with -32022, naming the revision it serves", async () => {
    const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "old-client", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      id: unknown;
      error: { code: number; data: { supported: string[] } };
    };
    expect(body.id).toBe(1);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toEqual([MCP_PROTOCOL_VERSION]);
  });

  it("refuses a 2025-era tasks/get like any other 2025-era request", async () => {
    const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { taskId: "t" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32022);
  });

  describe("logging", () => {
    let capture: ReturnType<typeof captureLogs>;
    beforeEach(() => {
      capture = captureLogs();
    });
    afterEach(() => {
      capture.restore();
    });

    it("logs a refused 2025-era client once per user agent, quoted and capped", async () => {
      const refuse = (userAgent: string) =>
        fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "User-Agent": userAgent,
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
        });
      const forged = 'probe/1.0 " identity=forged';
      await refuse(forged);
      await refuse(forged);
      await refuse("u".repeat(500));
      const lines = capture.lines.filter((l) =>
        l.includes("[mcp] refused a pre-2026-07-28 client"),
      );
      expect(
        lines.filter((l) => l.includes('userAgent="probe/1.0 \\" identity=forged"')),
      ).toHaveLength(1);
      expect(lines.some((l) => l.includes(`userAgent="${"u".repeat(200)}"`))).toBe(true);
    });

    it("info-logs each tools/call with the tool's name and who called it", async () => {
      const client = await createMcpClient();
      try {
        await client.callTool({ name: "fake__echo", arguments: { text: "secret words" } });
      } finally {
        await client.close();
      }
      const line = capture.lines.find((l) => l.startsWith("info [mcp] tools/call"));
      expect(line).toContain('tool="fake__echo"');
      expect(line).toContain("caller=agent");
      expect(line).toContain(`ws=${TEST_WORKSPACE_ID}`);
      expect(line).toContain("grant=first_party");
      expect(line).toContain("identity=");
      // Arguments are never written.
      expect(line).not.toContain("secret words");
    });

    it("quotes an app's source, so a source cannot write fields into the line", async () => {
      const client = await createMcpClient();
      const forged = 'fake tool="other__delete" ws=ws_forged';
      try {
        await client
          .callTool({
            name: "fake__echo",
            arguments: { text: "hi" },
            _meta: { "ai.nimblebrain/source": forged },
          })
          .catch(() => {});
      } finally {
        await client.close();
      }
      const line = capture.lines.find((l) => l.startsWith("info [mcp] tools/call"));
      expect(line).toContain(`caller=app:${JSON.stringify(forged)}`);
      expect(line).not.toContain("caller=app:fake ");
    });
  });
});

describe("MCP Server Auth", () => {
  let authHandle: ServerHandle;
  let authRuntime: Runtime;
  let authUrl: string;
  const TEST_API_KEY = "mcp-test-key-12345";
  const authTestDir = join(tmpdir(), `nimblebrain-mcp-auth-${Date.now()}`);

  beforeAll(async () => {
    mkdirSync(authTestDir, { recursive: true });

    authRuntime = await Runtime.start({
      identityProvider: testAuthAdapter(TEST_API_KEY),
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir: authTestDir,
    });

    await provisionTestWorkspace(authRuntime, TEST_WORKSPACE_ID, "Test Workspace", [
      TEST_IDENTITY.id,
    ]);

    authHandle = startServer({
      runtime: authRuntime,
      port: 0,
    });
    authUrl = `http://localhost:${authHandle.port}`;
  });

  afterAll(async () => {
    authHandle.stop(true);
    await authRuntime.shutdown();
    if (existsSync(authTestDir)) rmSync(authTestDir, { recursive: true });
  });

  it("returns 401 for unauthenticated POST /mcp/<wsId>", async () => {
    const res = await fetch(`${authUrl}/mcp/${TEST_WORKSPACE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("authenticated client can connect and list tools", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${authUrl}/mcp/${TEST_WORKSPACE_ID}`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
        },
      },
    );
    const client = newMcpClient({ name: "auth-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.listTools();
      expect(result.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("refuses bare /mcp with a valid token: 404 naming the URL shape, no default workspace", async () => {
    const res = await fetch(`${authUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = await readJson<JsonRpcErrorBody>(res);
    expect(body.error.message).toContain("/mcp/<workspaceId>");
  });

  it("refuses an unknown workspace with the same 404 as any unreachable one", async () => {
    const res = await fetch(`${authUrl}/mcp/ws_0052529305537a66`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(404);
    expect((await readJson<JsonRpcErrorBody>(res)).error.message).toBe("Workspace not found");
  });
});
