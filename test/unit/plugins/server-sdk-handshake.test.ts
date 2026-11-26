/**
 * `declareHostMeta` (packages/server-sdk) carries a plugin server's host metadata on the
 * handshake by wrapping two members the MCP SDK declares private. This guards the SDK
 * upgrade that renames them: the helper must still find them on a real `Server`, and the
 * metadata must still reach a client on both the `server/discover` (2026-07-28) and the
 * `initialize` (2025) handshake.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { declareHostMeta, HOST_META_KEY } from "../../../packages/server-sdk/src/index.ts";

const META = { hostVersion: "1.0", placements: [{ slot: "sidebar", resourceUri: "ui://x/panel" }] };

/** Send one request on `wire` and wait for its result. */
async function answer(
  wire: InMemoryTransport,
  method: string,
  params: Record<string, unknown>,
): Promise<{ _meta?: Record<string, unknown> } | undefined> {
  let result: { _meta?: Record<string, unknown> } | undefined;
  wire.onmessage = (message) => {
    if ("result" in message) result = message.result as typeof result;
  };
  await wire.start();
  await wire.send({ jsonrpc: "2.0", id: 1, method, params });
  for (let i = 0; i < 100 && !result; i++) await Bun.sleep(5);
  return result;
}

function server(): Server {
  const s = new Server({ name: "probe", version: "1.0.0" }, { capabilities: { tools: {} } });
  declareHostMeta(s, META);
  return s;
}

describe("declareHostMeta", () => {
  test("finds the SDK's handshake members on a real Server", () => {
    expect(() => server()).not.toThrow();
  });

  test("refuses an object without them", () => {
    expect(() => declareHostMeta({}, META)).toThrow(/needs updating/);
  });

  test("the server/discover result carries the block, through the SDK's serving entry", async () => {
    // The serving entries install the 2026-07-28 discover handler per connection; it must
    // still answer from the wrapped member.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(server, { transport: serverSide });
    const result = await answer(clientSide, "server/discover", {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "probe-client", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    });
    expect(result?._meta?.[HOST_META_KEY]).toEqual(META);
    await handle.close();
  });

  test("the initialize result carries the block", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server().connect(serverSide);
    const result = await answer(clientSide, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe-client", version: "1.0.0" },
    });
    expect(result?._meta?.[HOST_META_KEY]).toEqual(META);
    await clientSide.close();
  });
});
