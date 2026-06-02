import { describe, expect, it } from "bun:test";
import { textContent } from "../../../src/engine/content-helpers.ts";
import { NON_ADVANCING_META_KEY } from "../../../src/engine/types.ts";
import { makeInProcessSource } from "../../helpers/in-process-source.ts";

/**
 * Round-trip guard for the non-advancing `_meta` channel.
 *
 * `makeInProcessSource` runs a real in-process MCP server + client transport,
 * so a tool result here crosses the same `CallToolResult` serialization a
 * bundle's would. These tests prove a reverse-DNS `_meta` key set by a tool
 * survives that boundary and lands on the engine-side `ToolResult._meta` —
 * the assumption the loop supervisor's non-advancing trip depends on.
 */
describe("_meta round-trips across the tool boundary", () => {
  it("a tool's result `_meta` reaches the engine-side ToolResult", async () => {
    const source = await makeInProcessSource("test", [
      {
        name: "deadend",
        description: "Always reports no progress",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({
          content: textContent("nothing found"),
          isError: false,
          _meta: { [NON_ADVANCING_META_KEY]: true },
        }),
      },
    ]);

    const result = await source.execute("deadend", {});
    expect(result.isError).toBe(false);
    // The flag survived handler -> CallToolResult -> transport -> McpSource.
    expect(result._meta?.[NON_ADVANCING_META_KEY]).toBe(true);
  });

  it("a tool that sets no `_meta` yields no `_meta` on the result", async () => {
    const source = await makeInProcessSource("test", [
      {
        name: "plain",
        description: "Ordinary tool",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("ok"), isError: false }),
      },
    ]);

    const result = await source.execute("plain", {});
    expect(result._meta?.[NON_ADVANCING_META_KEY]).toBeUndefined();
  });
});
