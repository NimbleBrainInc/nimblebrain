/**
 * Tests for MCP endpoint workspace scoping.
 *
 * Validates that ListTools filters by workspace registry and CallTool
 * rejects tools from sources not in the workspace registry.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { startServer, type ServerHandle } from "../../../src/api/server.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { textContent } from "../../../src/engine/content-helpers.ts";
import { SharedSourceRef } from "../../../src/tools/registry.ts";
import type { ToolSource, Tool } from "../../../src/tools/types.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

// ── Fake tool sources ───────────────────────────────────────────────

/** A tool source that represents a workspace-scoped bundle. */
class FakeToolSource implements ToolSource {
  constructor(
    readonly name: string,
    private readonly toolList: Tool[],
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async tools(): Promise<Tool[]> {
    return this.toolList;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    return { content: textContent(`executed ${this.name}__${toolName}`), isError: false };
  }
}

// ── Setup ───────────────────────────────────────────────────────────

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let workDir: string;

// Source names
const ALLOWED_SOURCE = "allowed-bundle";
const DENIED_SOURCE = "denied-bundle";
const PROTECTED_SOURCE = "protected-bundle";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-ws-scope-"));

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);

  // Create the sources
  const allowedSource = new FakeToolSource(ALLOWED_SOURCE, [
    {
      name: `${ALLOWED_SOURCE}__greet`,
      description: "A greeting tool",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      source: "inline",
    },
  ]);

  const deniedSource = new FakeToolSource(DENIED_SOURCE, [
    {
      name: `${DENIED_SOURCE}__secret`,
      description: "A secret tool",
      inputSchema: { type: "object", properties: {} },
      source: "inline",
    },
  ]);

  const protectedSource = new FakeToolSource(PROTECTED_SOURCE, [
    {
      name: `${PROTECTED_SOURCE}__admin`,
      description: "A protected admin tool",
      inputSchema: { type: "object", properties: {} },
      source: "inline",
    },
  ]);

  // Sources are no longer registered on a global registry.
  // They'll be added to the workspace registry below.
  const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

  // Protected source is shared via SharedSourceRef
  wsRegistry.addSource(new SharedSourceRef(protectedSource));
  // Allowed source is in the workspace
  wsRegistry.addSource(new SharedSourceRef(allowedSource));

  // Denied source is NOT added to workspace registry

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────

async function createMcpClient(
  headers?: Record<string, string>,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          "x-workspace-id": TEST_WORKSPACE_ID,
          ...headers,
        },
      },
    },
  );
  const client = new Client({ name: "ws-scope-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("MCP workspace scoping", () => {
  it("ListTools returns only workspace + protected tools (not denied)", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      // Should include allowed and protected tools
      expect(names).toContain(`${ALLOWED_SOURCE}__greet`);
      expect(names).toContain(`${PROTECTED_SOURCE}__admin`);

      // Should NOT include denied bundle's tools
      expect(names).not.toContain(`${DENIED_SOURCE}__secret`);
    } finally {
      await client.close();
    }
  });

  it("CallTool to allowed bundle succeeds", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: `${ALLOWED_SOURCE}__greet`,
        arguments: { name: "world" },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([
        { type: "text", text: `executed ${ALLOWED_SOURCE}__greet` },
      ]);
    } finally {
      await client.close();
    }
  });

  it("CallTool to protected bundle succeeds", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: `${PROTECTED_SOURCE}__admin`,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("CallTool to non-workspace bundle returns error", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: `${DENIED_SOURCE}__secret`,
        arguments: {},
      });
      // The tool doesn't exist in the workspace registry, so execute will fail
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
