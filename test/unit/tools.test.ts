import { describe, expect, it } from "bun:test";
import { InlineSource } from "../../src/tools/inline-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { InlineToolDef } from "../../src/tools/inline-source.ts";
import { textContent, extractText } from "../../src/engine/content-helpers.ts";

function makeToolDef(name: string, description = ""): InlineToolDef {
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

describe("InlineSource", () => {
  it("exposes tools with prefix and executes handlers", async () => {
    const source = new InlineSource("test", [
      makeToolDef("greet", "Greet someone"),
      makeToolDef("farewell", "Say goodbye"),
    ]);

    await source.start();

    const tools = await source.tools();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("test__greet");
    expect(tools[0]!.description).toBe("Greet someone");
    expect(tools[0]!.source).toBe("inline:test");
    expect(tools[1]!.name).toBe("test__farewell");

    const result = await source.execute("greet", { name: "World" });
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("greet called");
    expect(extractText(result.content)).toContain("World");

    await source.stop();
  });

  it("returns error for unknown tool", async () => {
    const source = new InlineSource("test", [makeToolDef("greet")]);
    const result = await source.execute("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("Unknown tool");
  });
});

describe("ToolRegistry", () => {
  it("merges tools from multiple InlineSources with correct prefixes", async () => {
    const alpha = new InlineSource("alpha", [
      makeToolDef("greet"),
      makeToolDef("farewell"),
    ]);
    const beta = new InlineSource("beta", [
      makeToolDef("search"),
    ]);

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
    const alpha = new InlineSource("alpha", [
      {
        name: "greet",
        description: "Say hi",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("Hello from alpha!"), isError: false }),
      },
    ]);

    const registry = new ToolRegistry();
    registry.addSource(alpha);

    const result = await registry.execute({
      id: "call_1",
      name: "alpha__greet",
      input: {},
    });

    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toBe("Hello from alpha!");
  });

  it("returns error for unknown prefix", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new InlineSource("alpha", [makeToolDef("greet")]));

    const result = await registry.execute({
      id: "call_1",
      name: "unknown__greet",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("Unknown source");
  });

  it("removeSource makes tools disappear from availableTools", async () => {
    const alpha = new InlineSource("alpha", [makeToolDef("greet")]);
    const beta = new InlineSource("beta", [makeToolDef("search")]);

    const registry = new ToolRegistry();
    registry.addSource(alpha);
    registry.addSource(beta);

    expect((await registry.availableTools())).toHaveLength(2);

    await registry.removeSource("alpha");

    const tools = await registry.availableTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("beta__search");
  });

  it("sourceNames returns all registered source names", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new InlineSource("alpha", []));
    registry.addSource(new InlineSource("beta", []));

    const names = registry.sourceNames();
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toHaveLength(2);
  });

  it("hasSource checks registration", () => {
    const registry = new ToolRegistry();
    registry.addSource(new InlineSource("alpha", []));

    expect(registry.hasSource("alpha")).toBe(true);
    expect(registry.hasSource("beta")).toBe(false);
  });
});
