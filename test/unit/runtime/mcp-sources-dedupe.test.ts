import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";

/**
 * `mcpSources()` is the single seed for `HealthMonitor` (`api/server.ts`), so
 * whatever it drops is never monitored and never healed for the life of the
 * process. These pin the de-dup rule: collapse the same OBJECT shared across
 * registries, keep genuinely distinct instances that happen to share a name.
 *
 * Driven against the method with hand-built registries rather than a booted
 * Runtime — the rule is pure set logic over the registries, and a full boot
 * would obscure it.
 */
function runtimeWith(registries: Map<string, ToolRegistry>): Runtime {
  const rt = Object.create(Runtime.prototype) as Runtime & {
    _workspaceRegistries: Map<string, ToolRegistry>;
  };
  rt._workspaceRegistries = registries;
  return rt;
}

function remoteSource(name: string): McpSource {
  return new McpSource(
    name,
    { type: "remote", url: new URL(`https://${name}.example.com/mcp`) },
    new NoopEventSink(),
  );
}

describe("Runtime.mcpSources — what HealthMonitor gets to watch", () => {
  it("keeps every per-workspace instance of a bundle installed in many workspaces", () => {
    // A URL bundle's source name comes from the bundle, not the workspace
    // (`ref.serverName ?? deriveServerName(ref.url)`), so the SAME fleet bundle
    // in N workspaces produces N separate McpSource objects — separate
    // transports, separate sessions — under one name. Keying the de-dup on the
    // name kept the first and dropped the rest, so a source that went down in
    // any workspace but the first was never monitored.
    const wsA = new ToolRegistry();
    const wsB = new ToolRegistry();
    const wsC = new ToolRegistry();
    const inA = remoteSource("people");
    const inB = remoteSource("people");
    const inC = remoteSource("people");
    wsA.addSource(inA);
    wsB.addSource(inB);
    wsC.addSource(inC);

    const got = runtimeWith(
      new Map([
        ["ws_a", wsA],
        ["ws_b", wsB],
        ["ws_c", wsC],
      ]),
    ).mcpSources();

    expect(got).toHaveLength(3);
    expect(new Set(got)).toEqual(new Set([inA, inB, inC]));
  });

  it("still collapses one platform source object shared by every registry", () => {
    // Why the de-dup exists at all: `createWorkspaceRegistry` adds the same
    // platform source OBJECTS to every workspace registry. Identity de-dup
    // handles that exactly — they are literally the same object.
    const shared = remoteSource("platform-home");
    const wsA = new ToolRegistry();
    const wsB = new ToolRegistry();
    wsA.addSource(shared);
    wsB.addSource(shared);

    const got = runtimeWith(
      new Map([
        ["ws_a", wsA],
        ["ws_b", wsB],
      ]),
    ).mcpSources();

    expect(got).toHaveLength(1);
    expect(got[0]).toBe(shared);
  });

  it("handles the mixed shape: shared platform sources plus per-workspace bundles", () => {
    const shared = remoteSource("platform-home");
    const bundleA = remoteSource("tasks");
    const bundleB = remoteSource("tasks");
    const wsA = new ToolRegistry();
    const wsB = new ToolRegistry();
    for (const [reg, bundle] of [
      [wsA, bundleA],
      [wsB, bundleB],
    ] as const) {
      reg.addSource(shared);
      reg.addSource(bundle);
    }

    const got = runtimeWith(
      new Map([
        ["ws_a", wsA],
        ["ws_b", wsB],
      ]),
    ).mcpSources();

    // The shared platform source once; both per-workspace bundles.
    expect(got).toHaveLength(3);
    expect(got.filter((s) => s === shared)).toHaveLength(1);
    expect(new Set(got)).toEqual(new Set([shared, bundleA, bundleB]));
  });
});
