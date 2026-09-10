import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";

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

/** A minimal echo MCP server — the shape a third-party connector presents. */
function createEchoServer(): Server {
  const server = new Server({ name: "echo-test", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `Echo: ${request.params.arguments?.message}` }],
  }));

  return server;
}

describe("McpSource (integration)", () => {
  let server: RemoteMcpFixture;

  beforeEach(() => {
    server = startRemoteMcpServer(createEchoServer);
  });

  afterEach(() => {
    server.close();
  });

  it("connects to a remote MCP server and executes tools", async () => {
    const source = new McpSource(
      "echo-test",
      { type: "remote", url: new URL(server.url), allowInsecure: true },
      new NoopEventSink(),
    );

    await source.start();

    // Tools are lazy-loaded and prefixed
    const tools = await source.tools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo-test__echo");
    expect(tools[0]!.source).toBe("mcp:echo-test");

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
    const source = new McpSource(
      "echo-test",
      { type: "remote", url: new URL(server.url), allowInsecure: true },
      new NoopEventSink(),
    );
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
