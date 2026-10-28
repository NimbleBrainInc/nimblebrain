/**
 * The MCP Apps extension (`io.modelcontextprotocol/ui`) as a connector sees it.
 *
 * An MCP Apps server decides whether to offer UI from the client's declaration,
 * read with ext-apps' own `getUiCapability`, and falls back to a text-only tool
 * for a client without it. The fixture here does exactly that, so the test
 * passes only when the declaration reaches the server in a 2026-07-28
 * request's envelope. The 2025-era `initialize` claim is pinned in
 * `test/unit/mcp-source-client-capabilities.test.ts`: the SDK's
 * `legacyStatelessFallback` builds a server per request, so no request after
 * `initialize` could read it here.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { MCP_APP_MIME_TYPE } from "../../src/tools/apps-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

const RESOURCE_URI = "ui://apps-fixture/view";

/** One tool, with a `ui://` view only for a client that declares it renders MCP Apps. */
function buildServer(): Server {
  const server = new Server(
    { name: "apps-fixture", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler("tools/list", async () => {
    const ui = getUiCapability(server.getClientCapabilities());
    const rendersApps = ui?.mimeTypes?.includes(MCP_APP_MIME_TYPE) ?? false;
    return {
      tools: [
        {
          name: "weather",
          inputSchema: { type: "object" as const, properties: {} },
          ...(rendersApps ? { _meta: { ui: { resourceUri: RESOURCE_URI } } } : {}),
        },
      ],
    };
  });
  return server;
}

describe("an MCP Apps server on the 2026-07-28 era", () => {
  let http: ReturnType<typeof Bun.serve>;
  let source: McpSource;

  beforeAll(async () => {
    const handler = createMcpHandler(buildServer);
    http = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
    source = new McpSource(
      "apps",
      { type: "remote", url: new URL(`http://localhost:${http.port}/mcp`), allowInsecure: true },
      new NoopEventSink(),
    );
    await source.start();
  });

  afterAll(async () => {
    await source.stop();
    http.stop(true);
  });

  it("offers its UI, because the client declared the extension", async () => {
    const [tool] = await source.tools();
    expect(tool?.meta?.ui).toEqual({ resourceUri: RESOURCE_URI });
  });
});
