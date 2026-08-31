import { describe, expect, test } from "bun:test";
import {
  HookContractError,
  hookPortForSource,
  verifyRegisterTool,
} from "../../src/hooks/provisioning.ts";
import type { Tool, ToolResult } from "../../src/tools/types.ts";
import type { HookDeclaration } from "../../src/hooks/types.ts";

const DECL: HookDeclaration = {
  vendor: "acme",
  route: "/ingest/acme",
  register_tool: "set_webhook_url",
};

function tool(over: Partial<Tool> = {}): Tool {
  return {
    name: "set_webhook_url",
    description: "Register a webhook URL",
    inputSchema: {
      type: "object",
      properties: { vendor: { type: "string" }, url: { type: "string" } },
      required: ["vendor", "url"],
    },
    source: "acme-mcp",
    ...over,
  };
}

describe("verifyRegisterTool", () => {
  test("accepts a tool that takes { vendor, url }", () => {
    expect(() => verifyRegisterTool([tool()], DECL, "acme-mcp")).not.toThrow();
  });

  test("accepts extra optional arguments the server adds of its own", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          url: { type: "string" },
          replace_existing: { type: "boolean" },
        },
      },
    });
    expect(() => verifyRegisterTool([t], DECL, "acme-mcp")).not.toThrow();
  });

  test("accepts an untyped property — this is a compatibility gate, not a validator", () => {
    const t = tool({
      inputSchema: { type: "object", properties: { vendor: {}, url: {} } },
    });
    expect(() => verifyRegisterTool([t], DECL, "acme-mcp")).not.toThrow();
  });

  test("refuses a declaration whose register_tool does not exist", () => {
    // Catching this at install turns "the vendor never sends anything", noticed
    // months later, into a legible failure at the moment of the mistake.
    expect(() => verifyRegisterTool([tool({ name: "something_else" })], DECL, "acme-mcp")).toThrow(
      HookContractError,
    );
  });

  test.each([
    ["vendor", { url: { type: "string" } }],
    ["url", { vendor: { type: "string" } }],
  ])("refuses a register_tool that does not accept %s", (missing, properties) => {
    // The manifest names a tool but the ARGUMENT SHAPE appears in no schema a
    // third-party author can read, so the runtime checks it rather than hoping.
    const t = tool({ inputSchema: { type: "object", properties } });
    expect(() => verifyRegisterTool([t], DECL, "acme-mcp")).toThrow(new RegExp(missing));
  });

  test("refuses a register_tool whose argument is typed as something else", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { vendor: { type: "string" }, url: { type: "object" } },
      },
    });
    expect(() => verifyRegisterTool([t], DECL, "acme-mcp")).toThrow(HookContractError);
  });

  test("names the connector and the vendor so the operator can find the manifest", () => {
    try {
      verifyRegisterTool([tool({ name: "list_invoices" })], DECL, "acme-mcp");
      throw new Error("expected a contract error");
    } catch (err) {
      expect((err as Error).message).toContain("acme-mcp");
      expect((err as Error).message).toContain("acme");
      expect((err as Error).message).toContain("set_webhook_url");
    }
  });

  test("names what the server does advertise, so the reader is not sent to a correct manifest", () => {
    // The accusation on its own points at the manifest; the observed list is
    // what lets the reader see the actual mismatch — a rename, a tool behind a
    // flag the deployment does not set.
    const served = ["list_invoices", "create_invoice"].map((name) => tool({ name }));
    try {
      verifyRegisterTool(served, DECL, "acme-mcp");
      throw new Error("expected a contract error");
    } catch (err) {
      expect((err as Error).message).toContain("2 tools");
      expect((err as Error).message).toContain("list_invoices");
      expect((err as Error).message).toContain("create_invoice");
    }
  });

  test("caps the advertised names so a hundred-tool server cannot write an unbounded message", () => {
    const served = Array.from({ length: 40 }, (_, i) => tool({ name: `tool_${i}` }));
    try {
      verifyRegisterTool(served, DECL, "acme-mcp");
      throw new Error("expected a contract error");
    } catch (err) {
      expect((err as Error).message).toContain("40 tools");
      expect((err as Error).message).toContain("…");
      expect((err as Error).message).not.toContain("tool_39");
    }
  });
});

describe("hookPortForSource", () => {
  /**
   * A registry source advertises `<source>__<tool>` and takes the bare name on
   * `execute`. A declaration names the bare tool. Without the port translating
   * between them, every declared `register_tool` is absent from every tool list
   * and a correct manifest is reported as a contract violation — which is not a
   * transient failure: it fires identically on every attempt, for every
   * workspace, so no stream is ever provisioned.
   */
  function sourceServing(bare: string[]) {
    const executed: string[] = [];
    return {
      executed,
      port: hookPortForSource({
        tools: async () => bare.map((n) => tool({ name: `acme-mcp__${n}` })),
        execute: async (toolName: string): Promise<ToolResult> => {
          executed.push(toolName);
          return { content: [], isError: false };
        },
      }),
    };
  }

  test("presents the source's tools under the names a declaration uses", async () => {
    const { port } = sourceServing(["set_webhook_url", "list_invoices"]);

    const tools = await port.tools();

    expect(tools.map((t) => t.name)).toEqual(["set_webhook_url", "list_invoices"]);
    expect(() => verifyRegisterTool(tools, DECL, "acme-mcp")).not.toThrow();
  });

  test("carries the advertised schema through, so the contract check still sees it", async () => {
    const { port } = sourceServing(["set_webhook_url"]);

    const [t] = await port.tools();

    expect(t?.inputSchema).toEqual({
      type: "object",
      properties: { vendor: { type: "string" }, url: { type: "string" } },
      required: ["vendor", "url"],
    });
  });

  test("splits on the first separator, so a tool name may contain one itself", async () => {
    const { port } = sourceServing(["set__webhook__url"]);

    expect((await port.tools()).map((t) => t.name)).toEqual(["set__webhook__url"]);
  });

  test("dispatches by the bare name the source expects", async () => {
    const { port, executed } = sourceServing(["set_webhook_url"]);

    await port.execute("set_webhook_url", { vendor: "acme", url: "https://example.test/h" });

    expect(executed).toEqual(["set_webhook_url"]);
  });

  test("has no retrigger when the source has no tool-set signal", () => {
    const { port } = sourceServing(["set_webhook_url"]);
    expect(port.subscribeToolsChanged).toBeUndefined();
  });
});
