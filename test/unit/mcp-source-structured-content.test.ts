/**
 * A remote server's structured data reaches the agent loop as text; an
 * in-process platform source's result passes through as written, and so do a
 * remote tool's with an MCP Apps UI and one relayed to an outside client.
 */

import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { extractTextForModel } from "../../src/engine/content-helpers.ts";
import type { EventSink } from "../../src/engine/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { mcpSourceInternals } from "../helpers/mcp-source-internals.ts";
import { stub } from "../helpers/stub.ts";

const noopSink: EventSink = { emit: () => {} };

const ROWS = { records: [{ id: "7", vendor: "Acme Paper", amount: "250.00" }], totalCount: 1 };

function buildSource(
  mode: ConstructorParameters<typeof McpSource>[1],
  meta?: Record<string, unknown>,
): McpSource {
  const source = new McpSource("ledger", mode, noopSink);
  const fakeClient = stub<Client>({
    callTool: async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "Found 1 record(s)." }],
      structuredContent: ROWS,
      isError: false,
    }),
    close: async () => {},
  });
  const internals = mcpSourceInternals(source);
  internals.client = fakeClient;
  internals.cachedTools = [
    {
      name: "ledger__query",
      description: "",
      inputSchema: { type: "object", properties: {} },
      source: "mcp:ledger",
      meta,
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

  it("a remote tool with an MCP Apps UI keeps its structuredContent for the UI", async () => {
    const source = buildSource(
      { type: "remote", url: new URL("http://localhost:0/mcp") },
      { ui: { resourceUri: "ui://ledger/chart" } },
    );
    const result = await source.execute("query", {});
    expect(extractTextForModel(result.content)).toBe("Found 1 record(s).");
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
