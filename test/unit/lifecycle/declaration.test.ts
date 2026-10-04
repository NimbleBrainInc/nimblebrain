import { describe, expect, test } from "bun:test";
import {
  LifecycleContractError,
  verifyLifecycleTools,
} from "../../../src/lifecycle/declaration.ts";
import type { Tool } from "../../../src/tools/types.ts";

const GOOD = { on_ready: "workspace_ready", on_removing: "workspace_removing" };

/** A handler as a well-behaved server advertises it: no required arguments. */
function handler(name: string, over: Partial<Tool> = {}): Tool {
  return {
    name,
    description: "Lifecycle handler",
    inputSchema: { type: "object", properties: {} },
    source: "acme-mcp",
    ...over,
  };
}

describe("verifyLifecycleTools", () => {
  const tools = [handler("workspace_ready"), handler("workspace_removing")];

  test("accepts handlers that declare no arguments at all", () => {
    // `reason` must stay optional to the bundle. A server that never mentions
    // it is the common case and must not be reported as broken.
    expect(() => verifyLifecycleTools(tools, GOOD, "acme-mcp")).not.toThrow();
  });

  test("accepts a handler that declares `reason` itself", () => {
    const declared = [
      handler("workspace_ready", {
        inputSchema: { type: "object", properties: { reason: { type: "string" } } },
      }),
    ];
    expect(() =>
      verifyLifecycleTools(declared, { on_ready: "workspace_ready" }, "acme-mcp"),
    ).not.toThrow();
  });

  test("refuses a handler the server does not advertise, and names what it serves", () => {
    let thrown: unknown;
    try {
      verifyLifecycleTools(tools, { on_ready: "not_a_tool" }, "acme-mcp");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LifecycleContractError);
    expect(String(thrown)).toContain("not_a_tool");
    // Naming what the server DOES serve is what makes the message actionable.
    expect(String(thrown)).toContain("workspace_ready");
  });

  test("refuses a handler with a required property", () => {
    const required = [
      handler("workspace_ready", {
        inputSchema: {
          type: "object",
          properties: { campaign_id: { type: "string" } },
          required: ["campaign_id"],
        },
      }),
    ];
    expect(() =>
      verifyLifecycleTools(required, { on_ready: "workspace_ready" }, "acme-mcp"),
    ).toThrow(LifecycleContractError);
  });

  test("refuses a handler advertising execution.taskSupport required", () => {
    // Every lifecycle call is made inline, never task-augmented, so a handler
    // that requires a task can never be called.
    const augmented = [handler("workspace_removing", { execution: { taskSupport: "required" } })];
    // Naming the branch: a pass that threw for some other reason (a missing
    // tool, a required property) would prove nothing about this check.
    expect(() =>
      verifyLifecycleTools(augmented, { on_removing: "workspace_removing" }, "acme-mcp"),
    ).toThrow(/taskSupport/);
  });

  test.each([["forbidden"], ["optional"], [undefined]])(
    "admits a handler whose taskSupport is %s — the host calls it inline",
    (taskSupport) => {
      const inline = [
        handler("workspace_removing", {
          ...(taskSupport
            ? { execution: { taskSupport: taskSupport as "forbidden" | "optional" } }
            : {}),
        }),
      ];
      expect(() =>
        verifyLifecycleTools(inline, { on_removing: "workspace_removing" }, "acme-mcp"),
      ).not.toThrow();
    },
  );

  test("checks `on_removing` too, at the moment somebody is still watching", () => {
    // An `on_removing` typo would otherwise surface at uninstall — the one
    // moment nobody is looking and the one moment no retry follows.
    expect(() =>
      verifyLifecycleTools(tools, { ...GOOD, on_removing: "workspace_removed" }, "acme-mcp"),
    ).toThrow(/workspace_removed/);
  });

  test("bounds an error built from what the server said", () => {
    const many = Array.from({ length: 40 }, (_, i) => handler(`tool_${"x".repeat(80)}_${i}`));
    let message = "";
    try {
      verifyLifecycleTools(many, { on_ready: "workspace_ready" }, "acme-mcp");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // The names come off the wire; an unbounded join here is an unbounded log line.
    expect(message.length).toBeLessThan(1200);
    expect(message).toContain("…");
  });
});
