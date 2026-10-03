import { afterEach, describe, expect, test } from "bun:test";
import {
  type LifecycleNotifyDeps,
  notifyReady,
  notifyRemoving,
  resetReadyNotifications,
} from "../../../src/lifecycle/notify.ts";
import type { LifecycleBinding } from "../../../src/lifecycle/types.ts";
import type { ConnectorPort } from "../../../src/tools/connector-surface.ts";
import type { Tool, ToolResult } from "../../../src/tools/types.ts";

/**
 * Delivery of a binding declared through `ai.nimblebrain/lifecycle`: the same
 * events as the catalog path, with the extension's argument rule (`reason` only
 * to a handler that declares it) and its admission of a `taskSupport:
 * "optional"` handler. And the removal deadline covering a slow rediscovery.
 */

const WS = "ws_000f7ed6658f9d30";
const CONNECTOR = "acme-scope";

const WIRE: LifecycleBinding = {
  declaredBy: "extension",
  on_ready: "scope_ready",
  on_removing: "scope_removing",
};
const WIRE_READY: LifecycleBinding = { declaredBy: "extension", on_ready: "scope_ready" };

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    source: CONNECTOR,
    ...extra,
  };
}

function fakePort(tools: Tool[]) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const port: ConnectorPort = {
    tools: async () => tools,
    execute: async (name, input): Promise<ToolResult> => {
      calls.push({ tool: name, input });
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
  return { port, calls };
}

function deps(decl: () => Promise<LifecycleBinding | undefined>, port?: ConnectorPort) {
  return { declarationFor: decl, portFor: () => port } satisfies LifecycleNotifyDeps;
}

afterEach(() => resetReadyNotifications());

describe("ready, declared on the wire", () => {
  test("omits reason when the handler's schema does not declare it", async () => {
    const { port, calls } = fakePort([tool("scope_ready"), tool("scope_removing")]);
    const outcome = await notifyReady(
      deps(async () => WIRE, port),
      WS,
      CONNECTOR,
      "install",
    );
    expect(outcome.settled).toBe(true);
    expect(calls).toEqual([{ tool: "scope_ready", input: {} }]);
  });

  test("sends reason to a handler that declares it", async () => {
    const { port, calls } = fakePort([
      tool("scope_ready", {
        inputSchema: { type: "object", properties: { reason: { type: "string" } } },
      }),
    ]);
    await notifyReady(
      deps(async () => WIRE_READY, port),
      WS,
      CONNECTOR,
      "resume",
    );
    expect(calls).toEqual([{ tool: "scope_ready", input: { reason: "resume" } }]);
  });

  test('admits a taskSupport "optional" handler, which the catalog path refuses', async () => {
    const optional = { execution: { taskSupport: "optional" as const } };
    const { port, calls } = fakePort([tool("scope_ready", optional)]);
    await notifyReady(
      deps(async () => WIRE_READY, port),
      WS,
      CONNECTOR,
      "install",
    );
    expect(calls.map((c) => c.tool)).toEqual(["scope_ready"]);

    const catalog = { on_ready: "scope_ready" };
    await expect(
      notifyReady(
        deps(async () => catalog, port),
        WS,
        CONNECTOR,
        "install",
      ),
    ).rejects.toThrow("taskSupport");
  });

  test("an advertised binding with no handler calls nothing", async () => {
    const { port, calls } = fakePort([tool("search")]);
    const outcome = await notifyReady(
      deps(async () => ({ declaredBy: "extension" }), port),
      WS,
      CONNECTOR,
      "install",
    );
    expect(outcome.settled).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("removing", () => {
  test("the deadline covers a slow rediscovery, and no call starts after it", async () => {
    const { port, calls } = fakePort([tool("scope_removing")]);
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const started = Date.now();
    await notifyRemoving(
      deps(async () => {
        await slow;
        return WIRE;
      }, port),
      WS,
      CONNECTOR,
      { deadlineMs: 25 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });

  test("calls the wire handler with no arguments", async () => {
    const { port, calls } = fakePort([tool("scope_removing")]);
    await notifyRemoving(
      deps(async () => WIRE, port),
      WS,
      CONNECTOR,
    );
    expect(calls).toEqual([{ tool: "scope_removing", input: {} }]);
  });
});
