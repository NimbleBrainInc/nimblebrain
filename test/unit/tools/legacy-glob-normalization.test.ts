/**
 * Legacy `ws_<id>-` globs against bare tool names.
 *
 * Patterns reach `matchToolPattern` from `skill.allowedTools`,
 * `request.allowedTools`, and `delegate(tools: [...])`. The first two are
 * on-disk user/org/workspace-tier data, and `ws_<id>-source__*` was the
 * documented shape until the prefix was removed — so those patterns exist and
 * cannot be migrated by editing this repo.
 *
 * Normalizing only the tool NAME (which is what the code did) leaves such a
 * pattern matching zero tools, silently: a skill's `allowedTools` surfaces
 * nothing and reports nothing. Both sides are normalized now, at one site.
 */

import { describe, expect, test } from "bun:test";
import { filterTools } from "../../../src/tools/surfacing.ts";

const TOOLS = [
  { name: "crm__search", description: "", inputSchema: {} },
  { name: "crm__create", description: "", inputSchema: {} },
  { name: "conversations__list", description: "", inputSchema: {} },
] as never[];

const names = (pattern: string): string[] =>
  filterTools(TOOLS, [pattern]).map((t: { name: string }) => t.name);

describe("legacy glob normalization", () => {
  test("a bare glob matches, as it always did", () => {
    expect(names("crm__*")).toEqual(["crm__search", "crm__create"]);
    expect(names("crm__search")).toEqual(["crm__search"]);
  });

  test("a legacy `ws_<id>-` glob still matches", () => {
    // Without pattern normalization these are `[]` — the regression this pins.
    expect(names("ws_aaaaaaaaaaaaaaaa-crm__*")).toEqual(["crm__search", "crm__create"]);
    expect(names("ws_aaaaaaaaaaaaaaaa-crm__search")).toEqual(["crm__search"]);
  });

  test("a legacy glob's workspace id is IGNORED, not honored", () => {
    // The documented consequence. Pre-change, a glob naming a different
    // workspace matched nothing; now it normalizes into the session's own. Reach
    // is unchanged — the corpus is still only the bound workspace — but an
    // operator's workspace-specific directive now applies wherever it runs.
    // Pinned so the trade is visible rather than discovered.
    expect(names("ws_ffffffffffffffff-crm__*")).toEqual(["crm__search", "crm__create"]);
  });

  test("a non-matching glob still selects nothing", () => {
    expect(names("other__*")).toEqual([]);
    expect(names("ws_aaaaaaaaaaaaaaaa-other__*")).toEqual([]);
  });

  test("a malformed `ws_`-ish pattern is passed through, not thrown on", () => {
    // `bareToolName` is best-effort by contract; an unparseable pattern must not
    // take down tool surfacing.
    expect(names("ws_BAD!!-crm__*")).toEqual([]);
    expect(() => names("ws_-x")).not.toThrow();
  });

  test("identity tools match bare patterns unchanged", () => {
    expect(names("conversations__*")).toEqual(["conversations__list"]);
  });
});
