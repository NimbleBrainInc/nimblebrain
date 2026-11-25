import { describe, expect, test } from "bun:test";
import {
  checkAbsent,
  checkCursorWalk,
  checkToolList,
  contractSchema,
  expectForbidden,
  type ListedTool,
  PRIVATE_TOOLS,
  PUBLIC_TOOLS,
} from "../../../contracts/conversations/runner/conformance.ts";

function contractTools(names: readonly string[] = PUBLIC_TOOLS): ListedTool[] {
  return names.map((name) => ({
    name,
    description: `${name} conversations`,
    inputSchema: contractSchema(name, "input"),
    outputSchema: contractSchema(name, "output"),
  }));
}

describe("the contract's tools", () => {
  test("are split into public and private by contract.json", () => {
    expect([...PUBLIC_TOOLS].sort()).toEqual(
      ["export", "get", "list", "search", "stats", "update"].sort(),
    );
    expect([...PRIVATE_TOOLS].sort()).toEqual(
      ["append_events", "create", "delete", "delete_workspace", "events"].sort(),
    );
  });
});

describe("checkToolList", () => {
  test("passes when the server serves exactly the contract", () => {
    expect(() => checkToolList(contractTools(), PUBLIC_TOOLS)).not.toThrow();
  });

  test("passes when the server serves more than the contract", () => {
    const extra = {
      name: "archive",
      description: "an implementation's own tool",
      inputSchema: { type: "object", properties: { anything: { type: "string" } } },
    } as ListedTool;
    expect(() => checkToolList([...contractTools(), extra], PUBLIC_TOOLS)).not.toThrow();
  });

  test("fails when a contract tool is missing", () => {
    const tools = contractTools().filter((t) => t.name !== "search");
    expect(() => checkToolList(tools, PUBLIC_TOOLS)).toThrow(/missing contract tools: search/);
  });

  test("fails when a contract tool's schema differs", () => {
    const tools = contractTools().map((t) =>
      t.name === "get" ? { ...t, inputSchema: { type: "object" } } : t,
    );
    expect(() => checkToolList(tools, PUBLIC_TOOLS)).toThrow(/get inputSchema/);
  });
});

describe("checkToolList over the whole contract", () => {
  test("passes when one server serves every public and private tool", () => {
    const all = [...PUBLIC_TOOLS, ...PRIVATE_TOOLS];
    expect(() => checkToolList(contractTools(all), all)).not.toThrow();
  });

  test("fails when a private tool is missing", () => {
    const all = [...PUBLIC_TOOLS, ...PRIVATE_TOOLS];
    const tools = contractTools(all).filter((t) => t.name !== "append_events");
    expect(() => checkToolList(tools, all)).toThrow(/missing contract tools: append_events/);
  });
});

describe("checkAbsent", () => {
  test("passes when only public tools and others are listed", () => {
    const extra = { name: "archive", inputSchema: { type: "object" } } as ListedTool;
    expect(() => checkAbsent([...contractTools(), extra], PRIVATE_TOOLS)).not.toThrow();
  });

  test("fails naming each private tool that is listed", () => {
    const tools = contractTools([...PUBLIC_TOOLS, "events", "delete"]);
    expect(() => checkAbsent(tools, PRIVATE_TOOLS)).toThrow(/private tools listed: events, delete/);
  });
});

describe("checkCursorWalk", () => {
  const existing = ["a", "b", "c"];

  test("passes when a conversation created after the first page is absent", () => {
    expect(() => checkCursorWalk(["a", "b", "c"], existing)).not.toThrow();
  });

  test("passes when a conversation created after the first page appears", () => {
    expect(() => checkCursorWalk(["a", "b", "new", "c"], existing)).not.toThrow();
  });

  test("fails on a repeat", () => {
    expect(() => checkCursorWalk(["a", "b", "b", "c"], existing)).toThrow(/listed twice/);
  });

  test("fails on a skip", () => {
    expect(() => checkCursorWalk(["a", "c"], existing)).toThrow(/b skipped/);
  });
});

describe("expectForbidden", () => {
  const error = (body: unknown) => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
  });

  test("passes on forbidden", () => {
    expect(() => expectForbidden(error({ code: "forbidden", error: "x" }), "create")).not.toThrow();
  });

  test("fails when the call succeeded", () => {
    expect(() => expectForbidden({ structuredContent: { ok: true } }, "create")).toThrow(
      /succeeded/,
    );
  });

  test("fails when input was judged before the principal", () => {
    expect(() => expectForbidden(error({ code: "invalid_input", error: "x" }), "create")).toThrow(
      /invalid_input, want forbidden/,
    );
  });

  test("fails when scope was judged before the principal", () => {
    expect(() => expectForbidden(error({ code: "scope_missing", error: "x" }), "create")).toThrow(
      /scope_missing, want forbidden/,
    );
  });

  test("fails on an error with no code", () => {
    expect(() => expectForbidden(error({ error: "Forbidden" }), "create")).toThrow(
      /undefined, want forbidden/,
    );
  });
});
