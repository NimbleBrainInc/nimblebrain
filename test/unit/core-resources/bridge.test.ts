/**
 * The bridge preamble every core-resource script is concatenated with.
 *
 * It ships as a string evaluated in an iframe, so nothing else in this repo
 * type-checks it and the served scripts only ever exercise it against a live
 * host. Here it runs against a stubbed `Synapse` global, which is the only way
 * to assert what it actually does with a tool name or a result.
 *
 * What matters most is the sequencing. `connect()` resolves only after the host
 * answers `ui/initialize`, so every helper has to wait on one promise — and a
 * script that calls `callTool` on its first line (they all do) must still get
 * its answer rather than a crash on an undefined client.
 */
import { describe, expect, it } from "bun:test";
import { BRIDGE_HELPER } from "../../../src/tools/core-resources/scripts/_bridge.ts";

interface CallRecord {
  tool: string;
  args: unknown;
  options: unknown;
}

/**
 * Evaluate the preamble with a stubbed `Synapse` and hand back the functions it
 * defines, plus a log of what reached the host.
 *
 * `connectDelay` defers the handshake so the "called before ready" case is a
 * real race rather than an already-settled promise.
 */
function loadBridge(opts: { connectDelay?: number; result?: unknown } = {}) {
  const calls: CallRecord[] = [];
  const actions: Array<{ name: string; params: unknown }> = [];

  const app = {
    callTool(tool: string, args: unknown, options: unknown) {
      calls.push({ tool, args, options });
      return Promise.resolve({ data: opts.result ?? { ok: true }, isError: false });
    },
  };

  const Synapse = {
    connect: () =>
      opts.connectDelay
        ? new Promise((resolve) => setTimeout(() => resolve(app), opts.connectDelay))
        : Promise.resolve(app),
    action: (target: unknown, name: string, params: unknown) => {
      if (target !== app) throw new Error("action received something other than the app");
      actions.push({ name, params });
    },
  };

  const factory = new Function(
    "Synapse",
    `${BRIDGE_HELPER}\nreturn { callTool: callTool, navigate: navigate, parseResult: parseResult };`,
  );
  return { ...factory(Synapse), calls, actions };
}

describe("the core-resources bridge preamble", () => {
  it("answers a call made before the handshake resolves", async () => {
    // Every served script calls a tool on load, which is earlier than the host
    // can possibly have answered ui/initialize.
    const bridge = loadBridge({ connectDelay: 5, result: { items: [] } });
    await expect(bridge.callTool("list_apps", {})).resolves.toEqual({ items: [] });
  });

  it("unwraps the result to its data, so scripts read the tool's own shape", async () => {
    const bridge = loadBridge({ result: { sections: ["a"] } });
    expect(await bridge.callTool("settings_manifest", {})).toEqual({ sections: ["a"] });
  });

  it("sends a bare tool name to this app's own server", async () => {
    const bridge = loadBridge();
    await bridge.callTool("list_apps", { limit: 2 });
    expect(bridge.calls).toEqual([{ tool: "list_apps", args: { limit: 2 }, options: undefined }]);
  });

  it("splits server__tool into a tool name and an explicit server", async () => {
    const bridge = loadBridge();
    await bridge.callTool("people__list_contacts", { q: "x" });
    expect(bridge.calls).toEqual([
      { tool: "list_contacts", args: { q: "x" }, options: { server: "people" } },
    ]);
  });

  it("defaults missing arguments to an empty object rather than undefined", async () => {
    const bridge = loadBridge();
    await bridge.callTool("list_apps");
    expect(bridge.calls[0].args).toEqual({});
  });

  it("navigates through the host action, once connected", async () => {
    const bridge = loadBridge({ connectDelay: 5 });
    await bridge.navigate("/app/settings");
    expect(bridge.actions).toEqual([{ name: "navigate", params: { route: "/app/settings" } }]);
  });

  it("parseResult prefers structuredContent and otherwise passes the value through", () => {
    const bridge = loadBridge();
    expect(bridge.parseResult({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(bridge.parseResult({ a: 1 })).toEqual({ a: 1 });
    expect(bridge.parseResult(null)).toBeNull();
  });
});
