import { describe, expect, test } from "bun:test";
import { HookContractError, verifyRegisterTool } from "../../src/hooks/provisioning.ts";
import type { Tool } from "../../src/tools/types.ts";
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
      verifyRegisterTool([], DECL, "acme-mcp");
      throw new Error("expected a contract error");
    } catch (err) {
      expect((err as Error).message).toContain("acme-mcp");
      expect((err as Error).message).toContain("acme");
      expect((err as Error).message).toContain("set_webhook_url");
    }
  });
});
