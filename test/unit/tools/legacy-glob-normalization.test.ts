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
  // A granted personal connector, surfaced under the reserved marker.
  { name: "my_granola__list_meetings", description: "", inputSchema: {} },
  // …and a WORKSPACE source of the same underlying name, which is the whole
  // reason the marker exists.
  { name: "granola__list_meetings", description: "", inputSchema: {} },
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

describe("the personal marker is NOT normalized away", () => {
  // The `ws_<id>-` prefix is normalized on both sides because it identifies
  // nothing — a session has one workspace. The `my_` marker is the opposite: it
  // is the ONLY thing distinguishing the caller's own account from the
  // workspace's shared one. Normalizing it would collapse two credential sets
  // into one glob, which is exactly what the marker was introduced to prevent.
  test("a bare glob selects the workspace source, never the personal connector", () => {
    expect(names("granola__*")).toEqual(["granola__list_meetings"]);
  });

  test("a marked glob selects the personal connector, never the workspace source", () => {
    expect(names("my_granola__*")).toEqual(["my_granola__list_meetings"]);
  });

  test("delegation's documented opt-in path uses the marked form", () => {
    // `runtime.ts` states a sub-agent receives a granted personal connector only
    // when the parent opts in by glob. That opt-in has to name the form the
    // connector actually surfaces under, or it is a documented path that selects
    // nothing.
    expect(names("my_granola__list_meetings")).toEqual(["my_granola__list_meetings"]);
  });
});

describe("a normalized legacy pattern cannot reach a personal connector", () => {
  // Normalization exists to keep patterns authored against the retired prefix
  // working. Such a pattern could not have named a personal connector when it was
  // written — connectors were bare, and `ws_<id>-…` only matched namespaced
  // workspace tools — so normalizing it must not widen it.
  //
  // The dangerous case is the bare remainder: `ws_<id>-*` collapses to `*`.
  test("a legacy wildcard selects workspace tools only, never marked names", () => {
    expect(names("ws_aaaaaaaaaaaaaaaa-*")).not.toContain("my_granola__list_meetings");
    expect(names("ws_aaaaaaaaaaaaaaaa-*")).toContain("crm__search");
  });

  test("a legacy source-scoped wildcard is likewise confined", () => {
    expect(names("ws_aaaaaaaaaaaaaaaa-granola__*")).toEqual(["granola__list_meetings"]);
  });

  test("an AUTHORED bare wildcard is unaffected — it still reaches everything", () => {
    // Deliberate and separately warned about by the skill validator; the point is
    // that normalization does not silently manufacture this from a legacy glob.
    expect(names("*")).toContain("my_granola__list_meetings");
  });

  test("an authored marked glob still reaches the connector", () => {
    expect(names("my_granola__*")).toEqual(["my_granola__list_meetings"]);
  });
});
