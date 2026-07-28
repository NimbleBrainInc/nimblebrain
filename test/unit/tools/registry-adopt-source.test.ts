import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../../src/tools/types.ts";

/**
 * `adoptSource` is the canonical "register a freshly-built source" path. It
 * exists because a source can now be registered AND dead — the boot loop
 * retains a failed URL bundle so it stays visible and healable — which makes the
 * obvious `if (!hasSource) addSource` silently drop the fresh source and leave
 * the corpse routing every call.
 */
function fakeSource(name: string, alive: boolean): ToolSource & { stopped: boolean } {
  const s = {
    name,
    stopped: false,
    isAlive: () => alive,
    tools: async (): Promise<Tool[]> => [],
    execute: async () => ({ content: [], isError: false }),
    stop: async () => {
      s.stopped = true;
    },
  };
  return s as unknown as ToolSource & { stopped: boolean };
}

describe("ToolRegistry.adoptSource", () => {
  it("replaces a registered-but-dead source with the fresh one", async () => {
    // The Reconnect case: a boot-failed source holds the name, the user clicks
    // Reconnect, and startAuth builds a new source. Skipping registration here
    // is what leaves OAuth completing against a corpse.
    const registry = new ToolRegistry();
    const dead = fakeSource("people", false);
    const fresh = fakeSource("people", true);
    registry.addSource(dead);

    expect(await registry.adoptSource(fresh)).toBe(true);
    expect(registry.getSource("people")).toBe(fresh);
    // Evicted via removeSource → stop(), which is what marks the orphan terminal
    // to HealthMonitor so it can't revive it with a stale provider.
    expect(dead.stopped).toBe(true);
  });

  it("does not tear down a LIVE source under the same name", async () => {
    // Concurrent starts must not evict a working source.
    const registry = new ToolRegistry();
    const live = fakeSource("people", true);
    const other = fakeSource("people", true);
    registry.addSource(live);

    expect(await registry.adoptSource(other)).toBe(false);
    expect(registry.getSource("people")).toBe(live);
    expect(live.stopped).toBe(false);
  });

  it("registers when the name is free", async () => {
    const registry = new ToolRegistry();
    const fresh = fakeSource("people", true);
    expect(await registry.adoptSource(fresh)).toBe(true);
    expect(registry.getSource("people")).toBe(fresh);
  });

  it("is idempotent for a source already registered and live", async () => {
    const registry = new ToolRegistry();
    const live = fakeSource("people", true);
    registry.addSource(live);
    expect(await registry.adoptSource(live)).toBe(true);
    expect(registry.getSource("people")).toBe(live);
    expect(live.stopped).toBe(false);
  });
});
