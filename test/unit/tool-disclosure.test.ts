import { describe, expect, test } from "bun:test";
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { applyToolDisclosure } from "../../src/model/tool-disclosure.ts";

function tool(name: string): LanguageModelV3FunctionTool {
  return {
    type: "function",
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
  };
}

describe("applyToolDisclosure", () => {
  test("passthrough: returns the eager set unchanged; eagerCount = its length", () => {
    const directTools = [tool("a"), tool("b"), tool("c")];
    const { tools, eagerCount } = applyToolDisclosure({
      provider: "anthropic",
      directTools,
      deferredTools: [tool("d"), tool("e")], // ignored by passthrough
    });
    expect(tools).toEqual(directTools);
    expect(eagerCount).toBe(3);
  });

  test("unknown provider falls back to passthrough", () => {
    const directTools = [tool("a")];
    const { tools, eagerCount } = applyToolDisclosure({
      provider: "some-future-provider",
      directTools,
      deferredTools: [tool("z")],
    });
    expect(tools).toEqual(directTools);
    expect(eagerCount).toBe(1);
  });

  test("empty eager set yields eagerCount 0", () => {
    const { tools, eagerCount } = applyToolDisclosure({
      provider: "anthropic",
      directTools: [],
      deferredTools: [tool("z")],
    });
    expect(tools).toEqual([]);
    expect(eagerCount).toBe(0);
  });
});
