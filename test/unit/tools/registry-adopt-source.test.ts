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

/**
 * `hasLiveSource` is private — its only caller is `adoptSource`, and exposing two
 * similar predicates is how the wrong one gets picked. Reached deliberately here
 * to document the CONTRAST that justifies `hasEstablishedSource` existing at all.
 */
function liveness(registry: ToolRegistry, name: string): boolean {
  return (registry as unknown as { hasLiveSource: (n: string) => boolean }).hasLiveSource(name);
}

describe("ToolRegistry.hasEstablishedSource", () => {
  /** A source that is down, distinguished by whether it ever connected. */
  function downSource(name: string, everConnected: boolean): ToolSource {
    return {
      name,
      isAlive: () => false,
      // `startedAt` is set only on a successful connect and never reset, so
      // `uptime() === null` is exactly "never connected".
      uptime: () => (everConnected ? 5_000 : null),
      tools: async (): Promise<Tool[]> => [],
      execute: async () => ({ content: [], isError: false }),
      stop: async () => {},
    } as unknown as ToolSource;
  }

  it("is false for a source that never connected (a boot start that failed)", () => {
    // Nothing to reconnect to — it needs a full re-spawn, and until it gets one
    // it must not be offered as usable.
    const registry = new ToolRegistry();
    registry.addSource(downSource("people", false));
    expect(registry.hasEstablishedSource("people")).toBe(false);
    expect(liveness(registry, "people")).toBe(false);
  });

  it("is TRUE for a source whose transport merely dropped", () => {
    // The regression this exists to prevent. An idle close / network blip sets
    // `dead`, so `isAlive()` reads exactly like a boot failure — but this one
    // heals in place via reconnectOnDemand and the next sweep. Treating it as
    // absent runs a destructive re-spawn: it stop()s a working source, and the
    // replacement object is missing from HealthMonitor's boot snapshot, so the
    // bundle loses monitoring for the life of the process.
    const registry = new ToolRegistry();
    registry.addSource(downSource("people", true));
    expect(registry.hasEstablishedSource("people")).toBe(true);
    // Liveness alone cannot tell the two apart — that is the whole point.
    expect(liveness(registry, "people")).toBe(false);
  });

  it("is true for a live source and for an in-process source", () => {
    const registry = new ToolRegistry();
    registry.addSource(fakeSource("live", true));
    registry.addSource({
      name: "inprocess",
      tools: async (): Promise<Tool[]> => [],
      execute: async () => ({ content: [], isError: false }),
      stop: async () => {},
    } as unknown as ToolSource);
    expect(registry.hasEstablishedSource("live")).toBe(true);
    expect(registry.hasEstablishedSource("inprocess")).toBe(true);
  });

  it("is false for an absent source", () => {
    expect(new ToolRegistry().hasEstablishedSource("nope")).toBe(false);
  });
});
