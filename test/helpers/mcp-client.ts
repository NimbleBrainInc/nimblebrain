import { Client, type ClientOptions } from "@modelcontextprotocol/client";

/** The one protocol revision `/mcp/<wsId>` serves. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * An SDK client for `/mcp/<wsId>`, pinned to the revision it serves. A bare
 * `new Client(...)` speaks 2025-11-25, which the door refuses.
 */
export function newMcpClient(
  info: { name: string; version: string } = { name: "test-client", version: "1.0.0" },
  options: ClientOptions = {},
): Client {
  return new Client(info, {
    ...options,
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  });
}
