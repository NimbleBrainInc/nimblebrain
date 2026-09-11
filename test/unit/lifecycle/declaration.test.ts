import { describe, expect, test } from "bun:test";
import type { HostManifestMeta } from "../../../src/connectors/runtime/types.ts";
import { serverDetailToCatalogEntry } from "../../../src/connectors/catalog/projection.ts";
import type { ServerDetail } from "../../../src/connectors/catalog/server-detail.ts";
import {
  LifecycleContractError,
  parseLifecycleDeclaration,
  verifyLifecycleTools,
} from "../../../src/lifecycle/declaration.ts";
import type { Tool } from "../../../src/tools/types.ts";

function meta(lifecycle: unknown): HostManifestMeta {
  return { host_version: "1.4", lifecycle } as unknown as HostManifestMeta;
}

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

describe("parseLifecycleDeclaration", () => {
  test("keeps a well-formed block", () => {
    expect(parseLifecycleDeclaration(meta(GOOD))).toEqual(GOOD);
  });

  test("keeps either event declared alone", () => {
    expect(parseLifecycleDeclaration(meta({ on_ready: "ready" }))).toEqual({ on_ready: "ready" });
    expect(parseLifecycleDeclaration(meta({ on_removing: "bye" }))).toEqual({ on_removing: "bye" });
  });

  test("is absent-tolerant", () => {
    expect(parseLifecycleDeclaration(undefined)).toBeUndefined();
    expect(parseLifecycleDeclaration(meta(undefined))).toBeUndefined();
    expect(parseLifecycleDeclaration(meta({}))).toBeUndefined();
  });

  test("ignores a key that is not an event", () => {
    // Keyed by event, so an unknown key is a later contract this build does not
    // implement — dropped, never fatal, exactly like an unknown placement slot.
    expect(parseLifecycleDeclaration(meta({ ...GOOD, on_teatime: "kettle" }))).toEqual(GOOD);
  });

  test.each([
    ["a non-object block", "workspace_ready"],
    ["an array", [{ on_ready: "workspace_ready" }]],
  ])("drops %s entirely", (_label, bad) => {
    expect(parseLifecycleDeclaration(meta(bad))).toBeUndefined();
  });

  test.each([
    ["a non-string handler", { on_ready: 7, on_removing: "workspace_removing" }],
    ["an empty handler", { on_ready: "", on_removing: "workspace_removing" }],
    ["an over-long handler", { on_ready: "x".repeat(129), on_removing: "workspace_removing" }],
  ])("drops %s without dropping the sibling event", (_label, bad) => {
    // A typo costs that event, not the block and never the install — the same
    // tolerance `parseHookDeclarations` gives a malformed stream.
    expect(parseLifecycleDeclaration(meta(bad))).toEqual({ on_removing: "workspace_removing" });
  });
});

describe("the block reaches the catalog entry", () => {
  /** The smallest projectable `ServerDetail`. */
  function detail(hostMeta: Record<string, unknown>): ServerDetail {
    return {
      name: "com.acme/billing",
      description: "Billing",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://billing.acme.test/mcp" }],
      _meta: { "ai.nimblebrain/host": hostMeta },
    } as unknown as ServerDetail;
  }

  test("a declared block is carried; an absent one leaves the field off", () => {
    expect(serverDetailToCatalogEntry(detail({ host_version: "1.4", lifecycle: GOOD }))?.lifecycle)
      .toEqual(GOOD);
    expect(serverDetailToCatalogEntry(detail({ host_version: "1.0" }))?.lifecycle).toBeUndefined();
  });

  test("a malformed block leaves the entry installable", () => {
    const entry = serverDetailToCatalogEntry(detail({ host_version: "1.4", lifecycle: 42 }));
    expect(entry).not.toBeNull();
    expect(entry?.lifecycle).toBeUndefined();
  });
});

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

  test.each([["required"], ["optional"]])(
    "refuses a handler advertising execution.taskSupport %s",
    (taskSupport) => {
      // Both values route through `McpSource.execute`'s task path, whose await
      // settles only when the task terminates or the source is torn down. On
      // the uninstall path the teardown is what waits behind the call, so a
      // task-augmented handler turns "never fails the uninstall" into "hangs
      // it". An inline call is bounded by the MCP client's request deadline.
      const augmented = [
        handler("workspace_removing", {
          execution: { taskSupport: taskSupport as "required" | "optional" },
        }),
      ];
      expect(() =>
        verifyLifecycleTools(augmented, { on_removing: "workspace_removing" }, "acme-mcp"),
      ).toThrow(LifecycleContractError);
      // Naming the branch: a pass that threw for some other reason (a missing
      // tool, a required property) would satisfy the line above and prove
      // nothing about the check this test exists for.
      expect(() =>
        verifyLifecycleTools(augmented, { on_removing: "workspace_removing" }, "acme-mcp"),
      ).toThrow(/taskSupport/);
    },
  );

  test.each([["forbidden"], [undefined]])(
    "admits a handler whose taskSupport is %s — that is the inline path",
    (taskSupport) => {
      const inline = [
        handler("workspace_removing", {
          ...(taskSupport ? { execution: { taskSupport: taskSupport as "forbidden" } } : {}),
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
