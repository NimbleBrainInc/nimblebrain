import { describe, expect, test } from "bun:test";
import { hostOnlyToolDenial, isHostOnlyTool } from "../../src/permissions/host-only-tools.ts";

describe("isHostOnlyTool", () => {
  const decl = { on_ready: "scope_ready", on_removing: "scope_removing" };

  test("withholds each declared handler", () => {
    expect(isHostOnlyTool(decl, "scope_ready")).toBe(true);
    expect(isHostOnlyTool(decl, "scope_removing")).toBe(true);
  });

  test("leaves every other tool alone", () => {
    expect(isHostOnlyTool(decl, "search")).toBe(false);
    expect(isHostOnlyTool({ on_ready: "scope_ready" }, "scope_removing")).toBe(false);
  });

  test("withholds nothing without a declaration", () => {
    expect(isHostOnlyTool(undefined, "scope_ready")).toBe(false);
    expect(isHostOnlyTool({}, "scope_ready")).toBe(false);
  });
});

describe("hostOnlyToolDenial", () => {
  test("is a structured host_only_tool refusal naming the connector and tool", () => {
    const result = hostOnlyToolDenial("acme", "scope_removing");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "host_only_tool",
      connector: "acme",
      tool: "scope_removing",
    });
  });
});
