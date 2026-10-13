/**
 * Stand-ins for the connection state an `McpSource` holds after `start()`.
 *
 * A unit test that exercises what a source does once connected, without a
 * server, sets the private SDK client (and transport) a completed start would
 * have set. The client is usually a `stub<Client>` with the methods the path
 * calls.
 */

import type { Client, Request, StandardSchemaV1, Transport } from "@modelcontextprotocol/client";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { mcpSourceInternals } from "./mcp-source-internals.ts";

/** Put `source` in the connected state a `start()` on `era` leaves it in. */
export function connectMcpSource(
  source: McpSource,
  connection: { client: Client; transport?: Transport; era?: "legacy" | "modern" },
): void {
  const internals = mcpSourceInternals(source);
  internals.client = connection.client;
  if (connection.transport) internals.transport = connection.transport;
  if (connection.era) internals.protocolEra = connection.era;
}

/**
 * A `Client.request` for a custom (non-spec) method: `answer` returns the raw
 * result, and the fake validates it against the schema the caller passes, as
 * the SDK does.
 */
export function fakeSchemaRequest(answer: (request: Request) => Promise<unknown>) {
  return async <T extends StandardSchemaV1>(
    request: Request,
    resultSchema: T,
  ): Promise<StandardSchemaV1.InferOutput<T>> => {
    const validated = await resultSchema["~standard"].validate(await answer(request));
    if (!("value" in validated)) {
      throw new Error(`invalid result: ${JSON.stringify(validated.issues)}`);
    }
    // `validate` on a generic schema is typed by the constraint, so its output
    // reads as `unknown`; it is the schema's output.
    return validated.value as StandardSchemaV1.InferOutput<T>;
  };
}
