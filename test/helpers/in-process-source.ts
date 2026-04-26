/**
 * Test helper for tests that previously did `new InlineSource(name, tools)`.
 *
 * The platform replaced `InlineSource` with `defineInProcessApp` (an
 * in-process MCP server reachable via `InMemoryTransport`). Construction
 * is now async (the SDK `initialize` handshake) and requires an
 * `EventSink`. This helper compresses the boilerplate so tests that just
 * want a synchronous-looking source get one with one `await`.
 *
 * The returned source is **already started**. Tests that care about
 * lifecycle should call `source.stop()` in `afterEach`.
 */

import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { defineInProcessApp, type InProcessTool } from "../../src/tools/in-process-app.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";

export async function makeInProcessSource(
  name: string,
  tools: InProcessTool[],
  options?: {
    resources?: Map<string, string>;
    instructions?: string;
  },
): Promise<McpSource> {
  const source = defineInProcessApp(
    {
      name,
      version: "1.0.0",
      tools,
      resources: options?.resources,
      instructions: options?.instructions,
    },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}
