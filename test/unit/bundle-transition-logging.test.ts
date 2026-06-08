import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { log } from "../../src/cli/log.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import type { BundleInstance, BundleState } from "../../src/bundles/types.ts";

/**
 * Edge-triggered logging on BundleInstance.state transitions. Issue #194.
 *
 * Per-turn `availableTools()` enumeration of a stuck source must NOT emit
 * any operator-visible log. The single warn lives at the lifecycle
 * transition site and fires once per non-broken → broken edge.
 *
 * Broken set = { dead, crashed, reauth_required }. Excludes pending_auth
 * (in-flight OAuth — expected during normal Connect) and not_authenticated
 * (resting state on fresh install / after Disconnect).
 */

function makeInstance(state: BundleState = "running"): BundleInstance {
  return {
    serverName: "test-src",
    bundleName: "@scope/test",
    version: "1.0.0",
    state,
    trustScore: null,
    ui: null,
    briefing: null,
    httpProxy: null,
    protected: false,
    type: "plain",
    wsId: "ws_test",
  };
}

function makeSink(): EventSink & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

describe("BundleLifecycleManager.transition — edge-triggered logging", () => {
  let lifecycle: BundleLifecycleManager;
  let warnCalls: string[];
  let originalWarn: (msg: string) => void;

  beforeEach(() => {
    lifecycle = new BundleLifecycleManager(makeSink(), undefined);
    warnCalls = [];
    originalWarn = log.warn;
    log.warn = (msg) => {
      warnCalls.push(msg);
    };
  });

  afterEach(() => {
    log.warn = originalWarn;
  });

  test("running → dead emits exactly one warn", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain("test-src");
    expect(warnCalls[0]).toContain("dead");
  });

  test("running → crashed emits one warn", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "crashed");
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain("crashed");
  });

  test("running → reauth_required emits one warn", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "reauth_required");
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain("reauth_required");
  });

  test("repeated dead → dead does NOT warn again (no-op transition)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "dead");
    expect(warnCalls.length).toBe(1);
  });

  test("broken → broken (dead → crashed) does NOT warn (already broken)", () => {
    const inst = makeInstance("dead");
    lifecycle.transition(inst, "crashed");
    expect(warnCalls.length).toBe(0);
  });

  test("running → pending_auth does NOT warn (in-flight OAuth, not broken)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "pending_auth");
    expect(warnCalls.length).toBe(0);
  });

  test("running → not_authenticated does NOT warn (resting state)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "not_authenticated");
    expect(warnCalls.length).toBe(0);
  });

  test("running → starting does NOT warn (transient)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "starting");
    expect(warnCalls.length).toBe(0);
  });

  test("running → stopped does NOT warn (operator intent)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "stopped");
    expect(warnCalls.length).toBe(0);
  });

  test("recovery (dead → running) is silent — no warn", () => {
    const inst = makeInstance("dead");
    lifecycle.transition(inst, "running");
    expect(warnCalls.length).toBe(0);
  });

  test("re-entering broken after recovery warns again (running → dead → running → dead = 2 warns)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "running");
    lifecycle.transition(inst, "dead");
    expect(warnCalls.length).toBe(2);
  });

  test("instance.state field still updates on every call", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    expect(inst.state).toBe("dead");
    lifecycle.transition(inst, "running");
    expect(inst.state).toBe("running");
    lifecycle.transition(inst, "pending_auth");
    expect(inst.state).toBe("pending_auth");
  });
});
