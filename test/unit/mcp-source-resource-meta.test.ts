import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/**
 * Mock the MCP Client's `readResource` by reaching into the McpSource's
 * private client field. Keeps the test focused on the `_meta` passthrough
 * logic inside `readResource()` without spinning up a real MCP server.
 */
function makeSourceWithStubClient(stubResponse: unknown): McpSource {
  const source = new McpSource(
    "stub",
    { type: "remote", url: new URL("http://localhost:0/mcp") },
    new NoopEventSink(),
  );
  // deno-lint-ignore no-explicit-any
  (source as unknown as { client: { readResource: () => Promise<unknown> } }).client = {
    readResource: async () => stubResponse,
  };
  return source;
}

describe("McpSource.readResource — _meta passthrough", () => {
  it("preserves per-content _meta.ui through to ResourceData", async () => {
    const source = makeSourceWithStubClient({
      contents: [
        {
          uri: "ui://counter/show_clicker",
          mimeType: "text/html",
          text: "<html>hi</html>",
          _meta: {
            ui: {
              csp: {
                connectDomains: ["http://localhost:9991", "ws://localhost:9991"],
                frameDomains: ["http://localhost:9991"],
              },
            },
          },
        },
      ],
    });
    const result = await source.readResource("ui://counter/show_clicker");
    expect(result).not.toBeNull();
    expect(result?.text).toBe("<html>hi</html>");
    expect(result?.meta).toBeDefined();
    const ui = result?.meta?.ui as { csp?: { connectDomains?: string[] } };
    expect(ui?.csp?.connectDomains).toEqual(["http://localhost:9991", "ws://localhost:9991"]);
  });

  it("returns undefined meta when neither per-content nor result-level _meta is present", async () => {
    const source = makeSourceWithStubClient({
      contents: [{ uri: "ui://x", mimeType: "text/html", text: "<html/>" }],
    });
    const result = await source.readResource("ui://x");
    expect(result).not.toBeNull();
    expect(result?.meta).toBeUndefined();
  });

  it("merges result-level and content-level _meta with content-level precedence", async () => {
    const source = makeSourceWithStubClient({
      _meta: { ui: { prefersBorder: true }, foo: "from-result" },
      contents: [
        {
          uri: "ui://x",
          text: "<html/>",
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    });
    const result = await source.readResource("ui://x");
    const meta = result?.meta as { ui?: { prefersBorder?: boolean }; foo?: string };
    // content-level wins on `ui`
    expect(meta?.ui?.prefersBorder).toBe(false);
    // result-level field not touched by content still present
    expect(meta?.foo).toBe("from-result");
  });
});
