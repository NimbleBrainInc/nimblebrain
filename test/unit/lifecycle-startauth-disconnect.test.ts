import { beforeEach, describe, expect, test } from "bun:test";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance, BundleRef } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

/**
 * Coverage for the unified `lifecycle.startAuth` and `lifecycle.disconnect`
 * methods that landed with the self-service refactor. The happy path of
 * `startAuth` requires a running OAuth provider + transport, which is
 * exercised in the integration suite (workspace-oauth-provider.test).
 * This file covers the synchronous validation + state-machine glue:
 *
 *   - error paths (bundle not installed, missing URL, scope mismatch)
 *   - idempotence (existing pending_auth URL reused)
 *   - disconnect's symmetric behaviour across both scopes
 *   - state transitions emit the right SSE events
 */

class CapturingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
  byType(type: string): EngineEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

function seedInstance(
  lifecycle: BundleLifecycleManager,
  serverName: string,
  wsId: string,
  // Stage 2: only "workspace" is legal post-schema-cut.
  oauthScope: "workspace" = "workspace",
  ref?: BundleRef,
): BundleInstance {
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
    oauthScope,
    ...(ref ? { ref } : {}),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test internals
  (lifecycle as any).instances.set(`${serverName}|${wsId}`, instance);
  return instance;
}

const OPTS = { workDir: "/tmp/nb-test", callbackUrl: "http://localhost/callback" };

describe("BundleLifecycleManager.startAuth — validation & idempotence", () => {
  let sink: CapturingSink;
  let lifecycle: BundleLifecycleManager;

  beforeEach(() => {
    sink = new CapturingSink();
    lifecycle = new BundleLifecycleManager(sink, undefined);
  });

  test("rejects when bundle is not installed", async () => {
    await expect(
      lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS),
    ).rejects.toThrow(/not installed/);
  });

  test("rejects when bundle ref has no URL (named or local bundle)", async () => {
    seedInstance(lifecycle, "stdio", "ws_test", "workspace", { name: "@scope/stdio" });
    await expect(
      lifecycle.startAuth("stdio", "ws_test", "_workspace", OPTS),
    ).rejects.toThrow(/missing URL ref/);
  });

  test("rejects when principal is not the workspace principal (Stage 2: user-scope removed)", async () => {
    seedInstance(lifecycle, "granola", "ws_test", "workspace", {
      url: "https://example.test/mcp",
    });
    await expect(
      lifecycle.startAuth("granola", "ws_test", "user_alice", OPTS),
    ).rejects.toThrow(/not a workspace principal/);
  });

  test("returns existing pending_auth URL without restarting (debounces double-click)", async () => {
    const instance = seedInstance(lifecycle, "granola", "ws_test", "workspace", {
      url: "https://example.test/mcp",
    });
    const cachedUrl = "https://example.test/oauth/authorize?state=cached";
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: cachedUrl,
    });
    expect(instance.connections!.get("_workspace")!.authorizationUrl).toBe(cachedUrl);

    const result = await lifecycle.startAuth("granola", "ws_test", "_workspace", OPTS);
    expect(result.authorizationUrl).toBe(cachedUrl);
  });

  test("rejects re-auth when connection is already running (caller must disconnect first)", async () => {
    seedInstance(lifecycle, "granola", "ws_test", "workspace", {
      url: "https://example.test/mcp",
    });
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "running");

    await expect(
      lifecycle.startAuth("granola", "ws_test", "_workspace", OPTS),
    ).rejects.toThrow(/already connected/);
  });
});

describe("BundleLifecycleManager.disconnect — symmetric teardown", () => {
  let sink: CapturingSink;
  let lifecycle: BundleLifecycleManager;

  beforeEach(() => {
    sink = new CapturingSink();
    lifecycle = new BundleLifecycleManager(sink, undefined);
  });

  test("rejects when bundle is not installed", async () => {
    await expect(
      lifecycle.disconnect("ghost", "ws_test", "_workspace", { workDir: "/tmp" }),
    ).rejects.toThrow(/not installed/);
  });

  test("rejects when bundle has no URL ref (revocation requires the AS URL)", async () => {
    seedInstance(lifecycle, "stdio", "ws_test", "workspace", { name: "@scope/stdio" });
    await expect(
      lifecycle.disconnect("stdio", "ws_test", "_workspace", { workDir: "/tmp" }),
    ).rejects.toThrow(/missing URL ref/);
  });

  test("transitions Connection to not_authenticated and emits state_changed", async () => {
    const instance = seedInstance(lifecycle, "granola", "ws_test", "workspace", {
      url: "https://example.test/mcp",
    });
    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "running");
    sink.events = [];

    // disconnect calls revokeAndDeleteTokens — with no persisted tokens
    // the network revoke is a no-op and the local delete is best-effort
    // idempotent. We don't assert on those return fields here (they're
    // exercised in workspace-oauth-provider.test.ts); we care about the
    // lifecycle's own contract: state transition + source teardown.
    await lifecycle.disconnect("granola", "ws_test", "_workspace", {
      workDir: "/tmp/nb-test-disconnect",
    });

    expect(instance.connections!.get("_workspace")!.state).toBe("not_authenticated");
    expect(instance.connections!.get("_workspace")!.source).toBeNull();

    const stateEvents = sink.byType("connection.state_changed");
    expect(stateEvents.length).toBeGreaterThanOrEqual(1);
    const lastEvent = stateEvents[stateEvents.length - 1]!.data as Record<string, unknown>;
    expect(lastEvent.state).toBe("not_authenticated");
  });
});
