/**
 * A source shared by every workspace registry (the platform apps, the system
 * source) is owned by the runtime, not by any one registry. Removing it from a
 * workspace's registry — which is what uninstalling a connector of that name
 * does — leaves it registered and running for every workspace.
 */

import { describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { createWorkspaceRegistry } from "../../../src/runtime/workspace-runtime.ts";
import { defineInProcessApp } from "../../../src/tools/in-process-app.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";

const WS = "ws_0123456789abcdef";
const OTHER_WS = "ws_fedcba9876543210";

async function startApp(name: string): Promise<McpSource> {
  const source = defineInProcessApp({ name, version: "1.0.0", tools: [] }, new NoopEventSink());
  await source.start();
  return source;
}

describe("workspace registries — shared sources", () => {
  test("a workspace's removal of a shared source leaves it running for every workspace", async () => {
    const shared = await startApp("usage");
    const sink = new NoopEventSink();
    const mine = createWorkspaceRegistry(WS, [shared], null, sink);
    const theirs = createWorkspaceRegistry(OTHER_WS, [shared], null, sink);

    await mine.removeSource("usage");

    expect(shared.isAlive()).toBe(true);
    expect(mine.hasSource("usage")).toBe(true);
    expect(theirs.getSource("usage")).toBe(shared);
    await shared.stop();
  });

  test("the shared system source is kept the same way", async () => {
    const system = await startApp("nb");
    const registry = createWorkspaceRegistry(WS, [], system, new NoopEventSink());

    await registry.removeSource("nb");

    expect(system.isAlive()).toBe(true);
    expect(registry.hasSource("nb")).toBe(true);
    await system.stop();
  });

  test("a workspace's own source is removed and stopped", async () => {
    const registry = createWorkspaceRegistry(WS, [], null, new NoopEventSink());
    const own = await startApp("crm");
    registry.addSource(own);

    await registry.removeSource("crm");

    expect(own.isAlive()).toBe(false);
    expect(registry.hasSource("crm")).toBe(false);
  });
});
