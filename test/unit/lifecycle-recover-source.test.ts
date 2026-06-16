import { beforeEach, describe, expect, test } from "bun:test";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance, BundleRef } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink, ToolResult } from "../../src/engine/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

/**
 * Coverage for `BundleLifecycleManager.tryRecoverSource` — the best-effort,
 * cooldown-guarded re-registration the orchestrator calls on a source-miss
 * to self-heal a workspace whose connector was torn down without being
 * re-added (the Dropbox mid-run incident). The real re-spawn
 * (`ensureSourceRegistered` → `startBundleSource`) hits the network, so
 * these tests override it with a spy to pin the wrapper's own contract:
 * the guards, the never-throws promise, the negative-cache cooldown, and
 * cooldown-reset on success.
 */

class CapturingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
}

function stubSource(name: string): ToolSource {
  return {
    name,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text" as const, text: `[${name}] dispatched` }] };
    },
  };
}

const WS = "ws_test";
const WORK_DIR = "/tmp/nb-recover-test";

function seedInstance(lifecycle: BundleLifecycleManager, serverName: string, ref?: BundleRef): void {
  const instance: BundleInstance = {
    serverName,
    bundleName: "https://example.test/mcp",
    version: "remote",
    state: "starting",
    trustScore: null,
    ui: null,
    briefing: null,
    type: "plain",
    wsId: WS,
    oauthScope: "workspace",
    ...(ref ? { ref } : {}),
  };
  // biome-ignore lint/suspicious/noExplicitAny: reach into test internals
  (lifecycle as any).instances.set(`${serverName}|${WS}`, instance);
}

/** Replace `ensureSourceRegistered` with a spy; returns its call count getter. */
function spyEnsure(
  lifecycle: BundleLifecycleManager,
  impl: (serverName: string, wsId: string) => Promise<void>,
): () => number {
  let calls = 0;
  // biome-ignore lint/suspicious/noExplicitAny: override for the wrapper-under-test
  (lifecycle as any).ensureSourceRegistered = async (serverName: string, wsId: string) => {
    calls += 1;
    return impl(serverName, wsId);
  };
  return () => calls;
}

describe("BundleLifecycleManager.tryRecoverSource", () => {
  let lifecycle: BundleLifecycleManager;
  let registry: ToolRegistry;

  beforeEach(() => {
    lifecycle = new BundleLifecycleManager(new CapturingSink(), undefined);
    registry = new ToolRegistry();
    lifecycle.setWorkspaceRegistries(new Map([[WS, registry]]));
  });

  test("returns true (and never re-spawns) when the source is already registered", async () => {
    registry.addSource(stubSource("granola"));
    seedInstance(lifecycle, "granola", { url: "https://example.test/mcp" });
    const callCount = spyEnsure(lifecycle, async () => {});

    expect(await lifecycle.tryRecoverSource("granola", WS, WORK_DIR)).toBe(true);
    expect(callCount()).toBe(0); // fast path short-circuits before re-spawn
  });

  test("returns false for an unknown workspace registry (nothing to recover)", async () => {
    expect(await lifecycle.tryRecoverSource("granola", "ws_absent", WORK_DIR)).toBe(false);
  });

  test("returns false when no instance is installed for the source", async () => {
    const callCount = spyEnsure(lifecycle, async () => {});
    expect(await lifecycle.tryRecoverSource("ghost", WS, WORK_DIR)).toBe(false);
    expect(callCount()).toBe(0);
  });

  test("returns false for a non-URL (named/stdio) ref without attempting a re-spawn", async () => {
    seedInstance(lifecycle, "stdio", { name: "@scope/stdio" });
    const callCount = spyEnsure(lifecycle, async () => {});
    expect(await lifecycle.tryRecoverSource("stdio", WS, WORK_DIR)).toBe(false);
    expect(callCount()).toBe(0);
  });

  test("re-spawns once and returns true when recovery registers the source", async () => {
    seedInstance(lifecycle, "dropbox", { url: "https://mcp.dropbox.com/mcp" });
    const callCount = spyEnsure(lifecycle, async (name) => {
      registry.addSource(stubSource(name)); // simulate startBundleSource → addSource
    });

    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(true);
    expect(registry.hasSource("dropbox")).toBe(true);
    expect(callCount()).toBe(1);
  });

  test("never throws when the re-spawn fails — returns false", async () => {
    seedInstance(lifecycle, "dropbox", { url: "https://mcp.dropbox.com/mcp" });
    spyEnsure(lifecycle, async () => {
      throw new Error("startBundleSource refused");
    });

    // Must resolve, not reject — the orchestrator hot path depends on this.
    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(false);
    expect(registry.hasSource("dropbox")).toBe(false);
  });

  test("cooldown: a failed attempt suppresses a second re-spawn within the window", async () => {
    seedInstance(lifecycle, "dropbox", { url: "https://mcp.dropbox.com/mcp" });
    const callCount = spyEnsure(lifecycle, async () => {
      throw new Error("still broken");
    });

    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(false);
    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(false);
    // Second call is cooldown-suppressed — the broken bundle is NOT
    // re-spawned on every tool-call miss.
    expect(callCount()).toBe(1);
  });

  test("a successful recovery clears the cooldown so a later miss can retry", async () => {
    seedInstance(lifecycle, "dropbox", { url: "https://mcp.dropbox.com/mcp" });
    let attempt = 0;
    const callCount = spyEnsure(lifecycle, async (name) => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      registry.addSource(stubSource(name)); // second attempt succeeds
    });

    // First attempt fails and stamps the cooldown.
    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(false);
    // Within cooldown: suppressed (still 1 spawn).
    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(false);
    expect(callCount()).toBe(1);

    // Force the cooldown to expire, then a retry succeeds and clears the stamp.
    // biome-ignore lint/suspicious/noExplicitAny: reach into the negative cache
    (lifecycle as any).recoveryAttempts.set(`dropbox|${WS}`, 0);
    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(true);
    expect(callCount()).toBe(2);

    // Already-registered now → fast path, no further spawn.
    expect(await lifecycle.tryRecoverSource("dropbox", WS, WORK_DIR)).toBe(true);
    expect(callCount()).toBe(2);
  });
});
