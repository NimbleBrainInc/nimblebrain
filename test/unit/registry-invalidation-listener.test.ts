import { describe, expect, test } from "bun:test";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { SharedSourceRef, ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

/**
 * Regression guard for the stale-union bug fix. `ToolRegistry` is the single
 * place that knows source↔workspace, so it bridges two kinds of tool-set
 * change to its invalidation listener (which the Runtime wires to
 * `aggregator.invalidateWorkspace(wsId)`):
 *
 *   1. Source-SET membership changes — `addSource` / `removeSource`.
 *   2. Source-READINESS transitions — an already-registered source's tools
 *      becoming enumerable (subprocess (re)connect, deferred/pending-auth
 *      start, native `tools/list_changed`). This is the path that does NOT
 *      re-enter `addSource` and was therefore invisible before the fix: a
 *      HealthMonitor restart reuses the same source object.
 *
 * The original bug let a union memoized while a source was unreachable persist
 * for the process lifetime. These tests pin that every relevant transition
 * reaches the listener, and that detachment is clean on removal.
 */

/** A source that exposes the optional readiness-subscription surface and lets
 *  the test drive `tools/list_changed`-style emits on demand. */
class ReadinessSource implements ToolSource {
  readonly name: string;
  private listeners = new Set<() => void>();
  constructor(name: string) {
    this.name = name;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [{ name: `${this.name}__t`, description: "t", inputSchema: {}, source: this.name }];
  }
  async execute(toolName: string): Promise<ToolResult> {
    return { content: textContent(`ok ${toolName}`), isError: false };
  }
  subscribeToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Test hook: simulate a readiness transition / native list_changed. */
  fireToolsChanged(): void {
    for (const l of this.listeners) l();
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

/** A legacy source with no readiness surface — must not break wiring. */
class PlainSource implements ToolSource {
  readonly name = "plain";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [];
  }
  async execute(): Promise<ToolResult> {
    return { content: textContent("ok"), isError: false };
  }
}

describe("ToolRegistry — invalidation listener bridges tool-set changes", () => {
  test("addSource and removeSource each fire the invalidation listener", async () => {
    const registry = new ToolRegistry();
    let fired = 0;
    registry.setInvalidationListener(() => {
      fired++;
    });

    registry.addSource(new ReadinessSource("a"));
    expect(fired).toBe(1);

    await registry.removeSource("a");
    expect(fired).toBe(2);
  });

  test("an already-registered source's readiness emit fires the listener (the HealthMonitor-restart path)", () => {
    const registry = new ToolRegistry();
    const source = new ReadinessSource("crm");
    registry.addSource(source); // membership add: fire #1

    let readinessFires = 0;
    // Re-wire to count only readiness transitions from here on.
    registry.setInvalidationListener(() => {
      readinessFires++;
    });

    source.fireToolsChanged(); // restart / list_changed
    source.fireToolsChanged();
    expect(readinessFires).toBe(2);
  });

  test("removeSource detaches the readiness subscription (no leak, no post-removal fires)", async () => {
    const registry = new ToolRegistry();
    const source = new ReadinessSource("crm");
    registry.addSource(source);
    expect(source.listenerCount()).toBe(1);

    let fired = 0;
    registry.setInvalidationListener(() => {
      fired++;
    });

    await registry.removeSource("crm");
    expect(source.listenerCount()).toBe(0);

    // A stale emit from the (now-removed) source must not reach the registry.
    source.fireToolsChanged();
    expect(fired).toBe(1); // only the removeSource membership fire, not the stale emit
  });

  test("a source without subscribeToolsChanged still wires cleanly", () => {
    const registry = new ToolRegistry();
    let fired = 0;
    registry.setInvalidationListener(() => {
      fired++;
    });
    expect(() => registry.addSource(new PlainSource())).not.toThrow();
    expect(fired).toBe(1); // membership add still fires
  });

  test("SharedSourceRef forwards readiness subscriptions to the inner source", () => {
    const registry = new ToolRegistry();
    const inner = new ReadinessSource("platform");
    registry.addSource(new SharedSourceRef(inner));

    let readinessFires = 0;
    registry.setInvalidationListener(() => {
      readinessFires++;
    });

    // The inner shared source coming online must reach this registry's listener.
    inner.fireToolsChanged();
    expect(readinessFires).toBe(1);
  });

  test("no listener wired → mutations and emits are silent no-ops", () => {
    const registry = new ToolRegistry();
    const source = new ReadinessSource("crm");
    expect(() => registry.addSource(source)).not.toThrow();
    expect(() => source.fireToolsChanged()).not.toThrow();
  });
});
