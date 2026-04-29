import { beforeEach, describe, expect, test } from "bun:test";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

class CapturingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
  byType(type: string): EngineEvent[] {
    return this.events.filter((e) => e.type === type);
  }
  clear(): void {
    this.events = [];
  }
}

function seedInstance(lifecycle: BundleLifecycleManager, serverName: string, wsId: string): BundleInstance {
  const instance: BundleInstance = {
    serverName,
    bundleName: "https://example.test/mcp",
    version: "remote",
    state: "starting",
    trustScore: null,
    ui: null,
    briefing: null,
    httpProxy: null,
    protected: false,
    type: "plain",
    wsId,
  };
  // Reach through to register via the lifecycle's instance map. The
  // installRemote path normally does this, but for unit tests we want
  // to exercise just the connection-state-change machinery in isolation.
  // biome-ignore lint/suspicious/noExplicitAny: test internals
  (lifecycle as any).instances.set(`${serverName}|${wsId}`, instance);
  return instance;
}

describe("BundleLifecycleManager — Connection state transitions", () => {
  let sink: CapturingSink;
  let lifecycle: BundleLifecycleManager;

  beforeEach(() => {
    sink = new CapturingSink();
    lifecycle = new BundleLifecycleManager(sink, undefined);
  });

  test("recordConnectionStateChange creates the connection on first call", () => {
    const instance = seedInstance(lifecycle, "granola", "ws_test");
    expect(instance.connections).toBeUndefined();

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "starting");

    expect(instance.connections?.size).toBe(1);
    const c = instance.connections!.get("_workspace")!;
    expect(c.principalId).toBe("_workspace");
    expect(c.state).toBe("starting");
    expect(c.authorizationUrl).toBeUndefined();
  });

  test("emits connection.state_changed event with the right payload", () => {
    seedInstance(lifecycle, "granola", "ws_test");
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: "https://granola.test/oauth/authorize?state=abc",
    });

    const events = sink.byType("connection.state_changed");
    expect(events.length).toBe(1);
    expect(events[0]!.data).toMatchObject({
      wsId: "ws_test",
      serverName: "granola",
      principalId: "_workspace",
      state: "pending_auth",
      authorizationUrl: "https://granola.test/oauth/authorize?state=abc",
    });
  });

  test("BundleInstance.state mirrors the single connection state (Step 1 workspace-scope)", () => {
    const instance = seedInstance(lifecycle, "granola", "ws_test");
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: "https://x.test/?state=s",
    });
    expect(instance.state).toBe("pending_auth");

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "running");
    expect(instance.state).toBe("running");
  });

  test("authorizationUrl is cleared on transition out of pending_auth", () => {
    const instance = seedInstance(lifecycle, "granola", "ws_test");
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: "https://x.test/?state=s",
    });
    expect(instance.connections!.get("_workspace")!.authorizationUrl).toBe("https://x.test/?state=s");

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "running");
    expect(instance.connections!.get("_workspace")!.authorizationUrl).toBeUndefined();
  });

  test("getPendingAuthUrl returns URL only while pending_auth", () => {
    seedInstance(lifecycle, "granola", "ws_test");
    expect(lifecycle.getPendingAuthUrl("granola", "ws_test", "_workspace")).toBeNull();

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: "https://x.test/?state=s",
    });
    expect(lifecycle.getPendingAuthUrl("granola", "ws_test", "_workspace")).toBe("https://x.test/?state=s");

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "running");
    expect(lifecycle.getPendingAuthUrl("granola", "ws_test", "_workspace")).toBeNull();

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "dead");
    expect(lifecycle.getPendingAuthUrl("granola", "ws_test", "_workspace")).toBeNull();
  });

  test("getPendingAuthUrl returns null for unknown server / wsId / principal", () => {
    seedInstance(lifecycle, "granola", "ws_test");
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: "https://x.test/?state=s",
    });
    expect(lifecycle.getPendingAuthUrl("notexist", "ws_test", "_workspace")).toBeNull();
    expect(lifecycle.getPendingAuthUrl("granola", "ws_other", "_workspace")).toBeNull();
    expect(lifecycle.getPendingAuthUrl("granola", "ws_test", "other_member")).toBeNull();
  });

  test("recordConnectionStateChange on missing instance is a no-op (no throw, no emit)", () => {
    lifecycle.recordConnectionStateChange("ghost", "ws_test", "_workspace", "pending_auth");
    expect(sink.events.length).toBe(0);
  });

  test("lastError populates on dead transition; clears on running", () => {
    const instance = seedInstance(lifecycle, "granola", "ws_test");
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "dead", {
      lastError: "auth flow timed out",
    });
    expect(instance.connections!.get("_workspace")!.lastError).toBe("auth flow timed out");

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "running");
    expect(instance.connections!.get("_workspace")!.lastError).toBeUndefined();
  });
});
