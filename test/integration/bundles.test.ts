import { describe, expect, it, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalBundle } from "../../src/bundles/resolve.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { BundleManifest } from "../../src/bundles/types.ts";
import { extractText } from "../../src/engine/content-helpers.ts";

const testDir = join(tmpdir(), `nimblebrain-bundles-${Date.now()}`);

function setupTestDir() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
}

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("resolveLocalBundle", () => {
  beforeEach(setupTestDir);

  it("resolves an existing local path", () => {
    const bundleDir = join(testDir, "my-bundle");
    mkdirSync(bundleDir, { recursive: true });

    expect(resolveLocalBundle(bundleDir)).toBe(bundleDir);
  });

  it("returns null for nonexistent path", () => {
    expect(resolveLocalBundle("/nonexistent/bundle")).toBeNull();
  });
});

describe("ToolRegistry", () => {
  it("starts empty with no sources", async () => {
    const registry = new ToolRegistry();
    const tools = await registry.availableTools();
    expect(tools).toHaveLength(0);
  });

  it("returns error for unknown prefix", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute({
      id: "call_1",
      name: "unknown__tool",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("Unknown source");
  });

  it("returns error for invalid tool name format", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute({
      id: "call_1",
      name: "no-separator",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("Tool names must use the format");
  });
});

/** Helper: create a minimal echo MCP server bundle on disk. */
function createEchoBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });

  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "echo-test", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [
        {
          name: "echo",
          description: "Echo back the input",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => ({
      content: [{ type: "text", text: "Echo: " + request.params.arguments?.message }],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;

  writeFileSync(join(dir, "server.cjs"), serverCode);
  return dir;
}

describe("McpSource (integration)", () => {
  beforeEach(setupTestDir);

  it("spawns a local MCP server and executes tools", async () => {
    const bundleDir = createEchoBundle(join(testDir, "echo-bundle"));

    const source = new McpSource("echo-test", {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(bundleDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    });

    await source.start();

    // Tools are lazy-loaded and prefixed
    const tools = await source.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo-test__echo");
    expect(tools[0]!.source).toBe("mcpb:echo-test");

    // Execute
    const result = await source.execute("echo", { message: "Hello from test!" });
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toBe("Echo: Hello from test!");

    // Tools are cached (second call returns same)
    const tools2 = await source.tools();
    expect(tools2).toBe(tools);

    await source.stop();
  }, 15_000);

  it("works through ToolRegistry", async () => {
    const bundleDir = createEchoBundle(join(testDir, "echo-registry"));

    const source = new McpSource("echo-test", {
      type: "stdio",
      spawn: {
        command: "node",
        args: [join(bundleDir, "server.cjs")],
        env: process.env as Record<string, string>,
      },
    });
    await source.start();

    const registry = new ToolRegistry();
    registry.addSource(source);

    // Tools appear in registry
    const tools = await registry.availableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo-test__echo");

    // Execute through registry
    const result = await registry.execute({
      id: "call_1",
      name: "echo-test__echo",
      input: { message: "Hello via registry!" },
    });
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toBe("Echo: Hello via registry!");

    await registry.removeSource("echo-test");
  }, 15_000);
});
