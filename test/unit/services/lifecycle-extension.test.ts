import { describe, expect, test } from "bun:test";
import {
  advertisesLifecycle,
  LIFECYCLE_EXTENSION_ID,
  lifecycleClientExtension,
  readyArguments,
  selectLifecycleHandlers,
} from "../../../src/services/lifecycle-extension.ts";
import type { Tool } from "../../../src/tools/types.ts";

/**
 * The wire shape of `ai.nimblebrain/lifecycle`: which marked tools bind to which
 * event, which are refused, and what a `ready` call sends.
 */

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    source: "acme",
    ...extra,
  };
}

function marked(name: string, event: unknown, extra: Partial<Tool> = {}): Tool {
  return tool(name, { meta: { [LIFECYCLE_EXTENSION_ID]: { event } }, ...extra });
}

describe("selectLifecycleHandlers", () => {
  test("binds one marked tool per event, by the marker alone", () => {
    const { binding, rejected } = selectLifecycleHandlers([
      marked("scope_ready", "ready"),
      marked("scope_removing", "removing"),
      // Named like a handler and unmarked: not a handler.
      tool("workspace_ready"),
    ]);
    expect(binding).toEqual({
      declaredBy: "extension",
      on_ready: "scope_ready",
      on_removing: "scope_removing",
    });
    expect(rejected).toEqual([]);
  });

  test("an advertised extension with no marked tool binds no event", () => {
    expect(selectLifecycleHandlers([tool("search")])).toEqual({
      binding: { declaredBy: "extension" },
      rejected: [],
    });
  });

  test("two tools marked for one event leave it undeclared, and the other event bound", () => {
    const { binding, rejected } = selectLifecycleHandlers([
      marked("a_ready", "ready"),
      marked("b_ready", "ready"),
      marked("scope_removing", "removing"),
    ]);
    expect(binding).toEqual({ declaredBy: "extension", on_removing: "scope_removing" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toContain('"a_ready", "b_ready"');
    expect(rejected[0]?.reason).toContain("undeclared");
  });

  test("a duplicate counts even when one of the two could not be called", () => {
    const { binding } = selectLifecycleHandlers([
      marked("a_ready", "ready"),
      marked("b_ready", "ready", {
        inputSchema: { type: "object", properties: { x: {} }, required: ["x"] },
      }),
    ]);
    expect(binding.on_ready).toBeUndefined();
  });

  test("a marked tool with a required property is undeclared", () => {
    const { binding, rejected } = selectLifecycleHandlers([
      marked("scope_ready", "ready", {
        inputSchema: { type: "object", properties: { reason: {} }, required: ["reason"] },
      }),
    ]);
    expect(binding.on_ready).toBeUndefined();
    expect(rejected).toEqual([
      { tool: "scope_ready", event: "on_ready", reason: expect.stringContaining("required") },
    ]);
  });

  test('taskSupport "required" is undeclared; "optional" binds, since the host calls inline', () => {
    const { binding, rejected } = selectLifecycleHandlers([
      marked("scope_ready", "ready", { execution: { taskSupport: "required" } }),
      marked("scope_removing", "removing", { execution: { taskSupport: "optional" } }),
    ]);
    expect(binding).toEqual({ declaredBy: "extension", on_removing: "scope_removing" });
    expect(rejected.map((r) => r.tool)).toEqual(["scope_ready"]);
  });

  test("an unknown event is ignored and reported; a malformed marker likewise", () => {
    const { binding, rejected } = selectLifecycleHandlers([
      marked("scope_paused", "paused"),
      tool("odd", { meta: { [LIFECYCLE_EXTENSION_ID]: "ready" } }),
      marked("scope_ready", "ready"),
    ]);
    expect(binding).toEqual({ declaredBy: "extension", on_ready: "scope_ready" });
    expect(rejected.map((r) => r.tool)).toEqual(["scope_paused", "odd"]);
    expect(rejected[0]?.reason).toContain("unknown event");
  });

  test("unknown fields in the marker are tolerated", () => {
    const { binding } = selectLifecycleHandlers([
      tool("scope_ready", { meta: { [LIFECYCLE_EXTENSION_ID]: { event: "ready", v: 2 } } }),
    ]);
    expect(binding.on_ready).toBe("scope_ready");
  });
});

describe("readyArguments", () => {
  test("sends reason only to a handler whose schema declares it", () => {
    const declares = tool("r", {
      inputSchema: { type: "object", properties: { reason: { type: "string" } } },
    });
    expect(readyArguments(declares, "install")).toEqual({ reason: "install" });
    expect(readyArguments(tool("r"), "install")).toEqual({});
    expect(readyArguments(tool("r", { inputSchema: {} }), "resume")).toEqual({});
  });
});

describe("capability", () => {
  test("the client claim is the identifier with an empty settings object", () => {
    expect(lifecycleClientExtension()).toEqual({ "ai.nimblebrain/lifecycle": {} });
  });

  test("reads the advertisement from the extensions map, whatever its settings", () => {
    expect(advertisesLifecycle({ [LIFECYCLE_EXTENSION_ID]: { future: true } })).toBe(true);
    expect(advertisesLifecycle({ "ai.nimblebrain/facets": {} })).toBe(false);
  });
});
