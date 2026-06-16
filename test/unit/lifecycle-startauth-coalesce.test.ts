import { beforeEach, describe, expect, test } from "bun:test";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance, BundleRef } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";

/**
 * Coverage for the lifecycle-level OAuth coalesce: `authFlowsInFlight`
 * Map + the terminal-state release in `recordConnectionStateChange`.
 *
 * Pairs with `test/unit/workspace-oauth-provider-concurrency.test.ts`
 * (provider-level coalesce). Two layers, one invariant: at most one
 * OAuth flow per (serverName, wsId, principalId) at a time. The
 * provider tests pin the inner contract (state / verifier / client_id
 * / URL coherence under concurrent SDK auth() calls); this file pins
 * the outer contract (concurrent inbound /v1/mcp-auth/initiate
 * requests coalesce to one flow, and the slot is released exactly on
 * connection-terminal transitions).
 *
 * If any of these break, the production failure mode returns:
 * concurrent inbound requests each start a fresh provider + DCR +
 * source.start, and the lifecycle layer becomes a fresh-flow generator
 * instead of a coalesce point — re-opening the multi-fire race the
 * provider layer is designed to handle but shouldn't HAVE to.
 */

class CapturingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
}

function seedInstance(
  lifecycle: BundleLifecycleManager,
  serverName: string,
  wsId: string,
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
    type: "plain",
    wsId,
    oauthScope: "workspace",
    ...(ref ? { ref } : {}),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test internals
  (lifecycle as any).instances.set(`${serverName}|${wsId}`, instance);
  return instance;
}

function flowSlot(lifecycle: BundleLifecycleManager): Map<string, Promise<unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: test internals
  return (lifecycle as any).authFlowsInFlight;
}

const OPTS = { workDir: "/tmp/nb-test", callbackUrl: "http://localhost/callback" };
const KEY = "ghost|ws_test|_workspace";

describe("BundleLifecycleManager.startAuth — authFlowsInFlight coalesce", () => {
  let lifecycle: BundleLifecycleManager;

  beforeEach(() => {
    lifecycle = new BundleLifecycleManager(new CapturingSink(), undefined);
  });

  test("concurrent startAuth calls coalesce — startAuthInner runs ONCE regardless of caller count", async () => {
    // Coalescing is observable by spying on the inner method's call count:
    // the wrapper is `async`, so each caller gets a different OUTER promise
    // (referential equality on the wrapper's return value doesn't hold),
    // but ONLY the first caller advances past the mutex check and into
    // startAuthInner. Subsequent concurrent callers hit the slot and
    // await the already-running flow.
    let innerInvocations = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
    const orig = (lifecycle as any).startAuthInner.bind(lifecycle);
    // biome-ignore lint/suspicious/noExplicitAny: test instrumentation
    (lifecycle as any).startAuthInner = (...args: unknown[]) => {
      innerInvocations++;
      return orig(...args);
    };

    // Five concurrent calls in the same tick — N callers should produce
    // exactly one startAuthInner invocation.
    const results = await Promise.allSettled([
      lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS),
      lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS),
      lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS),
      lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS),
      lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS),
    ]);
    expect(innerInvocations).toBe(1);
    // All callers see the same rejection.
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.message).toMatch(/not installed/);
    }
  });

  test(".catch fallback clears the slot on pre-state-record sync failure (instance not found)", async () => {
    // No instance → sync throw → no state transition fires → the terminal-
    // state branch in recordConnectionStateChange never gets a chance to
    // release the slot. The wrapper's flow.catch is the safety net; without
    // it the key would be locked forever on the very first failed attempt.
    await expect(lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS)).rejects.toThrow();
    // Microtask drain so the .catch handler runs
    await Promise.resolve();
    expect(flowSlot(lifecycle).has(KEY)).toBe(false);
    // And the next attempt isn't stuck on the stale rejection — it's a
    // fresh call that also fails (different Promise reference).
    const next = lifecycle.startAuth("ghost", "ws_test", "_workspace", OPTS);
    await expect(next).rejects.toThrow(/not installed/);
  });

  test("recordConnectionStateChange releases the slot on every terminal state", () => {
    const terminals = [
      "running",
      "dead",
      "crashed",
      "stopped",
      "not_authenticated",
      "reauth_required",
    ] as const;
    for (const newState of terminals) {
      const lc = new BundleLifecycleManager(new CapturingSink(), undefined);
      seedInstance(lc, "granola", "ws_test", { url: "https://example.test/mcp" });
      // Inject a fake in-flight flow
      const fake = Promise.resolve({ authorizationUrl: "x" });
      flowSlot(lc).set("granola|ws_test|_workspace", fake);
      lc.recordConnectionStateChange("granola", "ws_test", "_workspace", newState);
      expect(flowSlot(lc).has("granola|ws_test|_workspace")).toBe(false);
    }
  });

  test("recordConnectionStateChange does NOT release the slot on starting / pending_auth (the in-flight states the mutex exists to coalesce across)", () => {
    seedInstance(lifecycle, "granola", "ws_test", { url: "https://example.test/mcp" });
    const fake = Promise.resolve({ authorizationUrl: "x" });
    flowSlot(lifecycle).set("granola|ws_test|_workspace", fake);

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "starting");
    expect(flowSlot(lifecycle).get("granola|ws_test|_workspace")).toBe(fake);

    lifecycle.recordConnectionStateChange("granola", "ws_test", "_workspace", "pending_auth", {
      authorizationUrl: "y",
    });
    expect(flowSlot(lifecycle).get("granola|ws_test|_workspace")).toBe(fake);
  });

  test("flow.catch's CAS does not clear a slot that's been reassigned to a later flow", async () => {
    // The wrapper's catch is `if (slot.get(key) === flow) slot.delete(key)`.
    // The CAS protects against: flow1 rejects async; meanwhile something
    // releases the slot (terminal state transition) and a fresh startAuth
    // sets the slot to flow2; when flow1's catch finally fires, it would
    // erroneously clear flow2 without the identity check.
    //
    // We can't intervene between startAuth's flow.catch registration and
    // its microtask firing (microtasks drain before any sync code we'd
    // run can intervene). Instead, mirror the wrapper's slot+catch
    // discipline directly with a controllable deferred — same semantics,
    // testable timing.
    const slot = flowSlot(lifecycle);
    let rejectFlow1!: (err: Error) => void;
    const flow1 = new Promise<{ authorizationUrl: string }>((_, rej) => {
      rejectFlow1 = rej;
    });
    slot.set(KEY, flow1);
    // The CAS that we're testing — identical to the wrapper's clear()
    flow1.catch(() => {
      if (slot.get(KEY) === flow1) slot.delete(KEY);
    });

    // Now swap the slot to a different flow (simulating terminal-state
    // release followed by a fresh startAuth that won the new slot).
    const flow2 = Promise.resolve({ authorizationUrl: "B" });
    slot.set(KEY, flow2);

    // NOW reject flow1 — its catch fires and the CAS should refuse to
    // touch flow2.
    rejectFlow1(new Error("flow1 failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(slot.get(KEY)).toBe(flow2);
  });
});
