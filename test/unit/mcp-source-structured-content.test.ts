/**
 * A remote server's structured data reaches the agent loop as text; an
 * in-process platform source's result passes through as written, and so does
 * one relayed to an outside client.
 */

import { describe, expect, it } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { extractTextForModel } from "../../src/engine/content-helpers.ts";
import type { EventSink } from "../../src/engine/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

const noopSink: EventSink = { emit: () => {} };

const ROWS = { records: [{ id: "7", vendor: "Acme Paper", amount: "250.00" }], totalCount: 1 };

function buildSource(mode: ConstructorParameters<typeof McpSource>[1]): McpSource {
  const source = new McpSource("ledger", mode, noopSink);
  const fakeClient = {
    callTool: async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "Found 1 record(s)." }],
      structuredContent: ROWS,
      isError: false,
    }),
    close: async () => {},
  };
  const internals = source as unknown as { client: unknown; cachedTools: unknown };
  internals.client = fakeClient;
  internals.cachedTools = [
    {
      name: "ledger__query",
      description: "",
      inputSchema: { type: "object", properties: {} },
      source: "mcp:ledger",
    },
  ];
  return source;
}

describe("McpSource — structured data for the agent loop", () => {
  it("a remote result carries its structuredContent as text", async () => {
    const source = buildSource({ type: "remote", url: new URL("http://localhost:0/mcp") });
    const result = await source.execute("query", {});
    expect(extractTextForModel(result.content)).toBe(`Found 1 record(s).\n${JSON.stringify(ROWS)}`);
    expect(result.structuredContent).toEqual(ROWS);
  });

  it("an in-process platform result passes through as written", async () => {
    const source = buildSource({
      type: "inProcess",
      createServer: async () => {
        throw new Error("unused");
      },
    });
    const result = await source.execute("query", {});
    expect(extractTextForModel(result.content)).toBe("Found 1 record(s).");
  });
});
