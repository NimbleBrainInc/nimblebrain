/**
 * A test MCP server that serves facets the way the `ai.nimblebrain/facets`
 * extension specifies: it advertises the extension in its capabilities, lists
 * each facet as a resource carrying `_meta["ai.nimblebrain/facets"]`, and
 * answers `resources/read` with `{ "count": n }`. Reached in-process, through a
 * real `McpSource` and handshake.
 */

import { InMemoryTransport, Server, type ServerCapabilities } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { FACETS_EXTENSION_ID } from "../../src/services/facets-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/** A `resources/list` entry for a facet: marked, titled, `application/json`. */
export function facetEntry(name: string, title: string, level?: string) {
  return {
    uri: `test://facets/${name}`,
    name,
    title,
    mimeType: "application/json",
    _meta: { [FACETS_EXTENSION_ID]: level === undefined ? {} : { level } },
  };
}

export interface FacetsServerOptions {
  /** Whether the server advertises the extension. Default: true. */
  advertises?: boolean;
  /** The `resources/list` entries, read on each request so a test can change them. */
  resources: () => unknown[];
  /** The text a read of `uri` returns, read on each request. May wait or throw. */
  read: (uri: string) => string | Promise<string>;
}

/** The fixture server and a started `McpSource` connected to it, recording reads. */
export async function startFacetsSource(
  name: string,
  opts: FacetsServerOptions,
): Promise<{ source: McpSource; reads: string[]; lists: () => number }> {
  const reads: string[] = [];
  let listCount = 0;
  const source = new McpSource(
    name,
    {
      type: "inProcess",
      createServer: async () => {
        const capabilities: ServerCapabilities = {
          resources: {},
          ...((opts.advertises ?? true) ? { extensions: { [FACETS_EXTENSION_ID]: {} } } : {}),
        };
        const server = new Server({ name, version: "1.0.0" }, { capabilities });
        server.setRequestHandler("resources/list", async () => {
          listCount++;
          return { resources: opts.resources() as never[] };
        });
        server.setRequestHandler("resources/read", async (request) => {
          reads.push(request.params.uri);
          const text = await opts.read(request.params.uri);
          return {
            contents: [{ uri: request.params.uri, mimeType: "application/json", text }],
          };
        });
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { server, clientTransport };
      },
    },
    new NoopEventSink(),
  );
  await source.start();
  return { source, reads, lists: () => listCount };
}
