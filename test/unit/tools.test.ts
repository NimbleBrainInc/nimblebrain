import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { extractText, textContent } from "../../src/engine/content-helpers.ts";
import { type InProcessTool } from "../../src/tools/in-process-app.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";

function makeToolDef(name: string, description = ""): InProcessTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    handler: async (input) => ({
      content: textContent(`${name} called with ${JSON.stringify(input)}`),
      isError: false,
    }),
  };
}

describe("defineInProcessApp", () => {
  it("exposes tools with prefix and executes handlers", async () => {
    const source = await makeInProcessSource("test", [
      makeToolDef("greet", "Greet someone"),
      makeToolDef("farewell", "Say goodbye"),
    ]);

    const tools = await source.tools();
    expect(tools).toHaveLength(2);
    const byName = (n: string) => tools.find((t) => t.name === n);
    expect(byName("test__greet")).toBeDefined();
    expect(byName("test__greet")!.description).toBe("Greet someone");
    expect(byName("test__greet")!.source).toBe("mcpb:test");
    expect(byName("test__farewell")).toBeDefined();

    const result = await source.execute("greet", { name: "World" });
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("greet called");
    expect(extractText(result.content)).toContain("World");

    await source.stop();
  });

  it("returns error for unknown tool", async () => {
    const source = await makeInProcessSource("test", [makeToolDef("greet")]);
    const result = await source.execute("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("Unknown tool");
    await source.stop();
  });
});

describe("ToolRegistry", () => {
  // Sources are kept across tests to avoid the InMemoryTransport handshake
  // overhead per test. Each test reads from independent sources, no mutation
  // crosses tests.
  let alpha: McpSource;
  let beta: McpSource;

  beforeAll(async () => {
    alpha = await makeInProcessSource("alpha", [makeToolDef("greet"), makeToolDef("farewell")]);
    beta = await makeInProcessSource("beta", [makeToolDef("search")]);
  });

  afterAll(async () => {
    await alpha.stop();
    await beta.stop();
  });

  it("merges tools from multiple sources with correct prefixes", async () => {
    const registry = new ToolRegistry();
    registry.addSource(alpha);
    registry.addSource(beta);

    const tools = await registry.availableTools();
    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t.name);
    expect(names).toContain("alpha__greet");
    expect(names).toContain("alpha__farewell");
    expect(names).toContain("beta__search");
  });

  it("routes 'alpha__greet' to alpha source", async () => {
    const greeter = await makeInProcessSource("greeter", [
      {
        name: "greet",
        description: "Say hi",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("Hello from alpha!"), isError: false }),
      },
    ]);

    const registry = new ToolRegistry();
    registry.addSource(greeter);

    const result = await registry.execute({
      id: "call_1",
      name: "greeter__greet",
      input: {},
    });

    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toBe("Hello from alpha!");
    await greeter.stop();
  });

  it("returns error for unknown prefix", async () => {
    const registry = new ToolRegistry();
    registry.addSource(alpha);

    const result = await registry.execute({
      id: "call_1",
      name: "unknown__greet",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("Unknown source");
  });

  it("removeSource makes tools disappear from availableTools", async () => {
    // Use fresh sources here — the test stops them, which would break later
    // tests that share `alpha`/`beta`.
    const a = await makeInProcessSource("a", [makeToolDef("greet")]);
    const b = await makeInProcessSource("b", [makeToolDef("search")]);

    const registry = new ToolRegistry();
    registry.addSource(a);
    registry.addSource(b);

    expect((await registry.availableTools())).toHaveLength(2);

    await registry.removeSource("a");

    const tools = await registry.availableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("b__search");
    await b.stop();
  });

  it("sourceNames returns all registered source names", () => {
    const registry = new ToolRegistry();
    registry.addSource(alpha);
    registry.addSource(beta);

    const names = registry.sourceNames();
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toHaveLength(2);
  });

  it("hasSource checks registration", () => {
    const registry = new ToolRegistry();
    registry.addSource(alpha);

    expect(registry.hasSource("alpha")).toBe(true);
    expect(registry.hasSource("beta")).toBe(false);
  });

  it("getSource returns the registered source by name, undefined otherwise", () => {
    const registry = new ToolRegistry();
    registry.addSource(alpha);

    expect(registry.getSource("alpha")).toBe(alpha);
    expect(registry.getSource("beta")).toBeUndefined();
  });
});
