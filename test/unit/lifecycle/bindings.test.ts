import { afterEach, describe, expect, test } from "bun:test";
import {
  forgetLifecycleBinding,
  type LifecycleSourceLike,
  lifecycleBindingFor,
  lifecycleContractWarnings,
  resetLifecycleBindings,
  snapshotLifecycleBinding,
} from "../../../src/lifecycle/bindings.ts";
import { LIFECYCLE_EXTENSION_ID } from "../../../src/services/lifecycle-extension.ts";
import type { Tool } from "../../../src/tools/types.ts";

/**
 * Holding a connection's `ai.nimblebrain/lifecycle` binding: snapshotted while
 * the connection is up, kept after it closes, and rediscovered (reconnecting
 * first) when nothing is held.
 */

const WS = "ws_000f7ed6658f9d30";
const CONNECTOR = "acme-scope";

function marked(name: string, event: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    source: CONNECTOR,
    meta: { [LIFECYCLE_EXTENSION_ID]: { event } },
  };
}

interface FakeSource extends LifecycleSourceLike {
  up: boolean;
  advertises: boolean;
  list: Tool[];
  reconnects: number;
}

function fakeSource(init: Partial<FakeSource> = {}): FakeSource {
  const s: FakeSource = {
    up: true,
    advertises: true,
    list: [marked("scope_ready", "ready"), marked("scope_removing", "removing")],
    reconnects: 0,
    connected: () => s.up,
    reconnect: async () => {
      s.reconnects++;
      s.up = true;
      return true;
    },
    serverExtensions: () => (s.up && s.advertises ? { [LIFECYCLE_EXTENSION_ID]: {} } : {}),
    tools: async () => s.list,
    ...init,
  };
  return s;
}

afterEach(() => resetLifecycleBindings());

describe("snapshotLifecycleBinding", () => {
  test("holds the binding, and keeps it after the connection closes", async () => {
    const source = fakeSource();
    await snapshotLifecycleBinding(WS, CONNECTOR, source);
    source.up = false;
    const wire = await lifecycleBindingFor(WS, CONNECTOR, source);
    expect(wire).toEqual({
      advertised: true,
      binding: { declaredBy: "extension", on_ready: "scope_ready", on_removing: "scope_removing" },
      rejected: [],
    });
  });

  test("a server that does not advertise is held as such, whatever it marks", async () => {
    const wire = await snapshotLifecycleBinding(WS, CONNECTOR, fakeSource({ advertises: false }));
    expect(wire).toEqual({ advertised: false });
  });

  test("knows nothing, and holds nothing, while the connection is down", async () => {
    const source = fakeSource({ up: false });
    expect(await snapshotLifecycleBinding(WS, CONNECTOR, source)).toBeUndefined();
    expect(await lifecycleBindingFor(WS, CONNECTOR, undefined)).toBeUndefined();
  });

  test("an empty tool list binds nothing and is not held", async () => {
    const source = fakeSource({ list: [] });
    const wire = await snapshotLifecycleBinding(WS, CONNECTOR, source);
    expect(wire).toEqual({ advertised: true, binding: { declaredBy: "extension" }, rejected: [] });
    source.list = [marked("scope_ready", "ready")];
    const later = await lifecycleBindingFor(WS, CONNECTOR, source);
    expect(later?.advertised && later.binding.on_ready).toBe("scope_ready");
  });

  test("a later snapshot replaces the held one (a tool-set change)", async () => {
    const source = fakeSource();
    await snapshotLifecycleBinding(WS, CONNECTOR, source);
    source.advertises = false;
    await snapshotLifecycleBinding(WS, CONNECTOR, source);
    expect(await lifecycleBindingFor(WS, CONNECTOR, source)).toEqual({ advertised: false });
  });
});

describe("lifecycleBindingFor", () => {
  test("with rediscover, reconnects a closed connection before concluding", async () => {
    const source = fakeSource({ up: false });
    const wire = await lifecycleBindingFor(WS, CONNECTOR, source, { rediscover: true });
    expect(source.reconnects).toBe(1);
    expect(wire?.advertised && wire.binding.on_removing).toBe("scope_removing");
  });

  test("without it, never dials a server", async () => {
    const source = fakeSource({ up: false });
    expect(await lifecycleBindingFor(WS, CONNECTOR, source)).toBeUndefined();
    expect(source.reconnects).toBe(0);
  });

  test("a forgotten binding is rediscovered", async () => {
    const source = fakeSource();
    await snapshotLifecycleBinding(WS, CONNECTOR, source);
    forgetLifecycleBinding(WS, CONNECTOR);
    source.advertises = false;
    expect(await lifecycleBindingFor(WS, CONNECTOR, source)).toEqual({ advertised: false });
  });
});

describe("lifecycleContractWarnings", () => {
  test("one sentence per rejection, none for a catalog connector", async () => {
    const source = fakeSource({
      list: [marked("a_ready", "ready"), marked("b_ready", "ready"), marked("x", "paused")],
    });
    const wire = await snapshotLifecycleBinding(WS, CONNECTOR, source);
    const warnings = lifecycleContractWarnings(CONNECTOR, wire);
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w).toContain(`Connector "${CONNECTOR}" marks`);
    expect(lifecycleContractWarnings(CONNECTOR, { advertised: false })).toEqual([]);
  });
});
