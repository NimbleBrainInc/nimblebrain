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
 * transition site, fires once per non-broken → broken edge, and a
 * matching info fires once per broken → running recovery edge.
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
  let infoCalls: string[];
  let originalWarn: (msg: string) => void;
  let originalInfo: (msg: string) => void;

  beforeEach(() => {
    lifecycle = new BundleLifecycleManager(makeSink(), undefined);
    warnCalls = [];
    infoCalls = [];
    originalWarn = log.warn;
    originalInfo = log.info;
    log.warn = (msg) => {
      warnCalls.push(msg);
    };
    log.info = (msg) => {
      infoCalls.push(msg);
    };
  });

  afterEach(() => {
    log.warn = originalWarn;
    log.info = originalInfo;
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

  test("dead → running emits one info (recovery edge)", () => {
    const inst = makeInstance("dead");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toContain("recovered");
    expect(infoCalls[0]).toContain("test-src");
  });

  test("reauth_required → running emits one info", () => {
    const inst = makeInstance("reauth_required");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
  });

  test("crashed → running emits one info", () => {
    const inst = makeInstance("crashed");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
  });

  test("broken → non-running (dead → not_authenticated) emits no info", () => {
    const inst = makeInstance("dead");
    lifecycle.transition(inst, "not_authenticated");
    expect(infoCalls.length).toBe(0);
    expect(warnCalls.length).toBe(0);
  });

  test("not_authenticated → running emits no info (was not broken)", () => {
    const inst = makeInstance("not_authenticated");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(0);
  });

  test("full cycle: running → dead → running → dead = 2 warns + 1 info", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "running");
    lifecycle.transition(inst, "dead");
    expect(warnCalls.length).toBe(2);
    expect(infoCalls.length).toBe(1);
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

/**
 * Multi-step recovery via sticky-bit. The direct broken → running edge
 * is rare in production — URL bundles recover through `pending_auth`
 * (user clicks Reconnect, completes OAuth) and stdio bundles recover
 * via a `restarting` intermediate. The sticky `lastBrokenState`
 * breadcrumb on `BundleInstance` carries the broken signal across
 * those intermediates so the recovery info still fires on the final
 * `→ running` hop.
 */
describe("BundleLifecycleManager.transition — multi-step recovery (sticky-bit)", () => {
  let lifecycle: BundleLifecycleManager;
  let warnCalls: string[];
  let infoCalls: string[];
  let originalWarn: (msg: string) => void;
  let originalInfo: (msg: string) => void;

  beforeEach(() => {
    lifecycle = new BundleLifecycleManager(makeSink(), undefined);
    warnCalls = [];
    infoCalls = [];
    originalWarn = log.warn;
    originalInfo = log.info;
    log.warn = (msg) => {
      warnCalls.push(msg);
    };
    log.info = (msg) => {
      infoCalls.push(msg);
    };
  });

  afterEach(() => {
    log.warn = originalWarn;
    log.info = originalInfo;
  });

  test("URL bundle reconnect: reauth_required → pending_auth → running emits one info", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "reauth_required");
    lifecycle.transition(inst, "pending_auth");
    lifecycle.transition(inst, "running");
    expect(warnCalls.length).toBe(1);
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toContain("reauth_required");
    expect(infoCalls[0]).toContain("recovered");
  });

  test("dead → not_authenticated → running still emits info (sticky preserved across intermediate)", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "not_authenticated");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toContain("dead");
  });

  test("recovery clears sticky-bit: second running after second-broken episode also fires info", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "running");
    lifecycle.transition(inst, "reauth_required");
    lifecycle.transition(inst, "pending_auth");
    lifecycle.transition(inst, "running");
    expect(warnCalls.length).toBe(2);
    expect(infoCalls.length).toBe(2);
    expect(infoCalls[0]).toContain("dead");
    expect(infoCalls[1]).toContain("reauth_required");
  });

  test("sticky-bit tracks LATEST broken state across broken→broken (crashed → dead → running labels 'dead')", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "crashed");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toContain("dead");
  });

  test("instance constructed in broken state: dead → running captures dead as label", () => {
    // Mirrors HealthMonitor crash recovery on a bundle that came up
    // dead before any transition flowed through this lifecycle instance.
    const inst = makeInstance("dead");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toContain("dead");
  });

  test("instance constructed in broken state: reauth_required → pending_auth → running captures reauth_required", () => {
    const inst = makeInstance("reauth_required");
    lifecycle.transition(inst, "pending_auth");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(1);
    expect(infoCalls[0]).toContain("reauth_required");
  });

  test("operator-stop clears sticky-bit: dead → stopped → starting → running emits no info", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    lifecycle.transition(inst, "stopped");
    lifecycle.transition(inst, "starting");
    lifecycle.transition(inst, "running");
    expect(warnCalls.length).toBe(1);
    expect(infoCalls.length).toBe(0);
  });

  test("starting → running on fresh boot emits no info (never broken)", () => {
    const inst = makeInstance("starting");
    lifecycle.transition(inst, "running");
    expect(infoCalls.length).toBe(0);
    expect(warnCalls.length).toBe(0);
  });

  test("lastBrokenState field is undefined after recovery", () => {
    const inst = makeInstance("running");
    lifecycle.transition(inst, "dead");
    expect(inst.lastBrokenState).toBe("dead");
    lifecycle.transition(inst, "running");
    expect(inst.lastBrokenState).toBeUndefined();
  });
});
