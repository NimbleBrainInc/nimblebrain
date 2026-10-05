import { describe, expect, test } from "bun:test";
import { unmatchedAllowedTools } from "../../../src/tools/tool-pattern.ts";

const REACHABLE = ["crm__search", "crm__update", "files__read", "my_gmail__send", "nb__use_skill"];

describe("unmatchedAllowedTools", () => {
  test("returns the entries nothing reachable matches, in list order", () => {
    expect(unmatchedAllowedTools(["close__*", "crm__*", "slack__post"], REACHABLE)).toEqual([
      "close__*",
      "slack__post",
    ]);
  });

  test("matches exact names, prefix globs, and suffix globs", () => {
    expect(unmatchedAllowedTools(["crm__search", "files__*", "*__update"], REACHABLE)).toEqual([]);
  });

  test("counts a discovery tool as matched whatever is reachable", () => {
    expect(unmatchedAllowedTools(["nb__search", "nb__manage_tools"], [])).toEqual([]);
  });

  test("holds the my_ marker: a workspace glob does not match a personal tool", () => {
    expect(unmatchedAllowedTools(["my_gmail__*", "gmail__*"], REACHABLE)).toEqual(["gmail__*"]);
  });

  test("matches an entry that carries the retired ws_<id>- prefix", () => {
    expect(unmatchedAllowedTools(["ws_0123456789abcdef-crm__search"], REACHABLE)).toEqual([]);
  });

  test("reports every entry when nothing is reachable", () => {
    expect(unmatchedAllowedTools(["crm__*"], [])).toEqual(["crm__*"]);
  });
});
