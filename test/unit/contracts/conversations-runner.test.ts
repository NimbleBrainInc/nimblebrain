import { describe, expect, test } from "bun:test";
import {
  APP_TOOLS,
  checkCursorWalk,
  checkToolList,
  contractSchema,
  type ListedTool,
} from "../../../contracts/conversations/runner/conformance.ts";

function contractTools(): ListedTool[] {
  return APP_TOOLS.map((name) => ({
    name,
    description: `${name} conversations`,
    inputSchema: contractSchema("app", name, "input"),
    outputSchema: contractSchema("app", name, "output"),
  })) as ListedTool[];
}

describe("checkToolList", () => {
  test("passes when the server serves exactly the contract", () => {
    expect(() => checkToolList(contractTools(), "app", APP_TOOLS)).not.toThrow();
  });

  test("passes when the server serves more than the contract", () => {
    const extra = {
      name: "archive",
      description: "an implementation's own tool",
      inputSchema: { type: "object", properties: { anything: { type: "string" } } },
    } as ListedTool;
    expect(() => checkToolList([...contractTools(), extra], "app", APP_TOOLS)).not.toThrow();
  });

  test("fails when a contract tool is missing", () => {
    const tools = contractTools().filter((t) => t.name !== "search");
    expect(() => checkToolList(tools, "app", APP_TOOLS)).toThrow(/missing contract tools: search/);
  });

  test("fails when a contract tool's schema differs", () => {
    const tools = contractTools().map((t) =>
      t.name === "get" ? { ...t, inputSchema: { type: "object" } } : t,
    );
    expect(() => checkToolList(tools, "app", APP_TOOLS)).toThrow(/get inputSchema/);
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
