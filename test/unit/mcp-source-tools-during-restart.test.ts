/**
 * A restart clears a source's tool memo before it connects again. A tool list
 * read in that window waits for the connection the restart is making, so a
 * door that lists tools before it calls one answers with the tools, never
 * "not found" (a files plugin that restarted answered 404 `tool_not_found`).
 */

import { describe, expect, it } from "bun:test";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/** A server listing one tool, connected `delayMs` after it is asked for. */
function slowServer(delayMs: number) {
  return async () => {
    await Bun.sleep(delayMs);
    const server = new Server({ name: "svc", version: "0.0.1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({
      tools: [{ name: "list", inputSchema: { type: "object" as const, properties: {} } }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return { server, clientTransport };
  };
}

describe("McpSource.tools() during a restart", () => {
  it("waits for the restart's connection and answers its tools", async () => {
    const source = new McpSource(
      "svc",
      { type: "inProcess", createServer: slowServer(50) },
      new NoopEventSink(),
    );
    await source.start();
    try {
      expect((await source.tools()).map((t) => t.name)).toEqual(["svc__list"]);
      const restarting = source.restart();
      // Let the restart stop the old connection and clear the memo.
      await Bun.sleep(10);
      const tools = await source.tools();
      expect(tools.map((t) => t.name)).toEqual(["svc__list"]);
      expect(await restarting).toBe(true);
    } finally {
      await source.stop();
    }
  });

  it("still answers not started for a source that is down and not restarting", async () => {
    const source = new McpSource(
      "svc",
      { type: "inProcess", createServer: slowServer(0) },
      new NoopEventSink(),
    );
    await source.start();
    await source.stop();
    await expect(source.tools()).rejects.toThrow("not started");
  });
});
