import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------
//
// The session-miss tests below assert on log content, not just status codes.
// The whole reason this PR's logs exist is to make session-miss diagnoseable
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
    model: { provider: "custom", adapter: createEchoModel() },
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
  const client = new Client({ name: "test-client", version: "1.0.0" });
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

  // Standalone GET /mcp/<wsId> is the spec's optional server→client SSE channel.
  // We deliberately don't implement it (see comment on `handleMcpRequest`)
  // because we don't push standalone notifications and a long-lived
  // idle connection gets killed by intermediate proxies. Returning 405
  // is the spec-blessed escape hatch — the SDK client treats it as
  // "server doesn't offer GET-style listening" and proceeds POST-only.
  it("returns 405 for GET /mcp/<wsId> so the SDK skips the standalone SSE stream", async () => {
    const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    await res.body?.cancel();
  });

  // Session-miss surface: a POST carrying an unknown session ID must return
  // 404 with a JSON-RPC error envelope, the new `error.data.reason`
  // classification (`not_found` for an unknown sessionId; `unavailable`
  // when the registry has it but the local transport doesn't), AND emit a
  // structured log line. This is the fault the client sees after a process
  // restart, an idle-TTL sweep, or a sticky-routing miss — exactly what
  // `[mcp] session miss` is logged for.
  describe("session-miss logging", () => {
    let capture: ReturnType<typeof captureLogs>;
    beforeEach(() => {
      capture = captureLogs();
    });
    afterEach(() => {
      capture.restore();
    });

    it("returns 404 with reason=not_found and warn-logs key=value context", async () => {
      const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });
      expect(res.status).toBe(404);
      const body = await readJson<JsonRpcErrorBody>(res);
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toBe("Session not found");
      // Default registry is in-memory and starts empty; an unknown
      // sessionId necessarily lands on `not_found`, not `unavailable`.
      expect(body.error?.data?.reason).toBe("not_found");

      // Asserting prefix + key=value shape rather than the exact
      // string lets future tweaks to wording survive. The session is
      // bound to (identity, workspace), so the line names both.
      const line = capture.lines.find((l) => l.startsWith("warn [mcp] session miss"));
      expect(line).toBeDefined();
      expect(line).toContain("reason=not_found");
      expect(line).toContain("sessionId=00000000");
      expect(line).toContain(`workspace=${TEST_WORKSPACE_ID}`);
      expect(line).toMatch(/identity=\S+/);
      expect(line).toMatch(/ip=\S+/);
    });

    // Companion case: a non-init POST with no session id at all. Different
    // code path (we never look in the map) but the same client confusion.
    it("returns 400 and warn-logs for non-init POST without a session id", async () => {
      const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });
      expect(res.status).toBe(400);

      const line = capture.lines.find((l) =>
        l.startsWith("warn [mcp] non-init request without session id"),
      );
      expect(line).toBeDefined();
      expect(line).toContain("sessionId=none");
      expect(line).toContain(`workspace=${TEST_WORKSPACE_ID}`);
    });

    // A session miss has no `clientInfo` to read, so the user agent is what
    // names the client. It and the left-most forwarded IP are JSON-quoted
    // because the client controls both.
    it("names the client by user agent on a session miss", async () => {
      await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": 'probe/1.0 " identity=forged',
          "X-Forwarded-For": "203.0.113.7 workspace=forged, 10.0.0.1",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      const line = capture.lines.find((l) =>
        l.startsWith("warn [mcp] non-init request without session id"),
      );
      expect(line).toContain('ua="probe/1.0 \\" identity=forged"');
      expect(line).toContain('ip="203.0.113.7 workspace=forged"');
    });

    it("caps a client-supplied log field at 200 characters", async () => {
      await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": "u".repeat(500),
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      const line = capture.lines.find((l) =>
        l.startsWith("warn [mcp] non-init request without session id"),
      );
      expect(line).toContain(`ua="${"u".repeat(200)}"`);
    });

    it("info-logs the declared clientInfo when a session initializes", async () => {
      const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": "probe/1.0",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "probe-client", version: "2.3.4" },
          },
          id: 1,
        }),
      });
      expect(res.status).toBe(200);
      const line = capture.lines.find((l) => l.startsWith("info [mcp] session initialized"));
      expect(line).toBeDefined();
      expect(line).toContain('client="probe-client/2.3.4"');
      expect(line).toContain('ua="probe/1.0"');
      expect(line).toContain(`workspace=${TEST_WORKSPACE_ID}`);
    });

    it("returns 404 and info-logs identity context for DELETE with unknown session id", async () => {
      const res = await fetch(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`, {
        method: "DELETE",
        headers: {
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
      });
      expect(res.status).toBe(404);

      // Regression guard: identity and workspace must reach the DELETE
      // log line for cross-tenant correlation.
      const line = capture.lines.find((l) => l.startsWith("info [mcp] delete session miss"));
      expect(line).toBeDefined();
      expect(line).toContain("sessionId=00000000");
      expect(line).toContain(`workspace=${TEST_WORKSPACE_ID}`);
      expect(line).toMatch(/identity=\S+/);
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
      model: { provider: "custom", adapter: createEchoModel() },
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
    const client = new Client({ name: "auth-test", version: "1.0.0" });
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
