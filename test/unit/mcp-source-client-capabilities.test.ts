/**
 * What `McpSource` claims of itself in the `initialize` handshake.
 *
 * A client capability is a promise a server is entitled to plan around: it says
 * "send me this and I will handle it." Every entry here is therefore checked
 * against a call site that exists, not against an intention.
 *
 * `tasks.list` was the one that wasn't. Nothing in the host calls `listTasks`,
 * and SEP-2663 removes `tasks/list` from the spec, so the claim could only ever
 * have invited a server to expect a client that never arrived.
 *
 * Read from the server end of a real in-process handshake, so what is asserted
 * is what a bundle actually receives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";

/** The capabilities the connected server saw us declare. */
function declaredCapabilities(source: McpSource) {
  const server = (source as unknown as { inProcessServer: Server | null }).inProcessServer;
  return server?.getClientCapabilities();
}

describe("McpSource client capabilities", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("claims task-augmented tools/call and cancel, and does NOT claim tasks.list", async () => {
    source = await makeInProcessSource("caps", [
      {
        name: "noop",
        description: "Does nothing.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("{}"), isError: false }),
      },
    ]);

    const tasks = declaredCapabilities(source)?.tasks as
      | { requests?: { tools?: { call?: unknown } }; cancel?: unknown; list?: unknown }
      | undefined;

    // Both of these are exercised: `startToolAsTask` opens the stream,
    // `cancelTask` cancels it.
    expect(tasks?.requests?.tools?.call).toBeDefined();
    expect(tasks?.cancel).toBeDefined();
    expect(tasks?.list).toBeUndefined();
  });
});
