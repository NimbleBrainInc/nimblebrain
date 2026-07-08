import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { ToolSource } from "../../src/tools/types.ts";

/**
 * Integration: `getIdentityConnectorSource` lazy-starts a user's personal
 * connector from the persisted `connectors.json` record and holds it in the
 * user's registry. Drives a real Streamable-HTTP MCP server so the whole
 * `startBundleSource` → `{type:"user"}` provider → registry path runs end to
 * end (no auth on the fake server — the DCR provider is built but never
 * challenged).
 */

function createMcpServer(): Server {
  const server = new Server(
    { name: "fake-granola", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "read_notes", description: "read notes", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  return server;
}

interface FakeServer {
  url: string;
  close: () => void;
}

function startFakeServer(): FakeServer {
  let counter = 0;
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const existing = transports.get(sid);
        if (existing) return existing.handleRequest(req);
        return new Response("no session", { status: 404 });
      }
      // Fresh initialize → mint a session + transport.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => `sess-${++counter}`,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      await createMcpServer().connect(transport);
      return transport.handleRequest(req);
    },
  });
  return {
    url: `http://localhost:${httpServer.port}/mcp`,
    close: () => httpServer.stop(true),
  };
}

describe("getIdentityConnectorSource — lazy-start", () => {
  let workDir: string;
  let server: FakeServer;
  let lifecycle: BundleLifecycleManager;
  const started: ToolSource[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-idc-lazy-"));
    server = startFakeServer();
    // allowInsecureRemotes: true so the localhost fake server passes SSRF checks.
    lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined, true);
  });

  afterEach(async () => {
    // Stop any sources this test started so their transports don't linger.
    for (const s of started) await s.stop().catch(() => {});
    started.length = 0;
    server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function install(userId: string, serverName: string): Promise<void> {
    await new IdentityConnectorStore({ workDir }).add(userId, {
      url: server.url,
      serverName,
      ui: null,
    });
  }

  async function resolve(userId: string, serverName: string): Promise<ToolSource | undefined> {
    const source = await lifecycle.getIdentityConnectorSource(userId, serverName, workDir);
    if (source) started.push(source);
    return source;
  }

  it("lazy-starts a user's connector from the persisted record and resolves its tools", async () => {
    await install("usr_alice", "granola");
    const source = await resolve("usr_alice", "granola");
    expect(source).toBeDefined();
    // Tools come back source-qualified (`<serverName>__<tool>`).
    const toolNames = (await source?.tools())?.map((t) => t.name);
    expect(toolNames).toContain("granola__read_notes");
  });

  it("is idempotent — a second call returns the same started source (no re-spawn)", async () => {
    await install("usr_alice", "granola");
    const first = await resolve("usr_alice", "granola");
    const second = await lifecycle.getIdentityConnectorSource("usr_alice", "granola", workDir);
    expect(second).toBe(first);
  });

  it("de-dups concurrent first-calls — no double-spawn, both get the same source", async () => {
    await install("usr_alice", "granola");
    // Two simultaneous first-calls: without the in-flight guard this would
    // double-spawn a transport and the losing addSource would throw / leak.
    const [a, b] = await Promise.all([
      lifecycle.getIdentityConnectorSource("usr_alice", "granola", workDir),
      lifecycle.getIdentityConnectorSource("usr_alice", "granola", workDir),
    ]);
    if (a) started.push(a);
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });

  it("returns undefined for a connector the user hasn't installed", async () => {
    await install("usr_alice", "granola");
    expect(await resolve("usr_alice", "notion")).toBeUndefined();
  });

  it("is per-user — another user with no record gets nothing", async () => {
    await install("usr_alice", "granola");
    expect(await resolve("usr_bob", "granola")).toBeUndefined();
  });
});
