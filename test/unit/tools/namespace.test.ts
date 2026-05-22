/**
 * Unit tests for `src/tools/namespace.ts`.
 *
 * Pins the primitive's contract for Stage 2 of the delegation-model
 * refactor. Failure modes covered (in order of likelihood we'd silently
 * regress):
 *
 *  - `parseNamespacedToolName` silently falling back to "current
 *    workspace" on a non-namespaced input (the Stage 1 lesson 3
 *    failure mode).
 *  - `namespacedToolName` accepting a wsId carrying path traversal
 *    or whitespace — the Stage 2 invariant lift that motivates the
 *    `WORKSPACE_ID_RE` import.
 *  - Embedded `/` in tool name being mis-split (we take the FIRST `/`
 *    as the separator; this contract is asserted explicitly).
 *  - Round-trip property: anything `namespacedToolName` produces must
 *    parse back to the same `{wsId, toolName}`. If this breaks, the
 *    primitive is internally inconsistent.
 */

import { describe, expect, test } from "bun:test";
import {
  InvalidNamespacedToolNameInput,
  namespacedToolName,
  parseNamespacedToolName,
  UnknownNamespacedToolName,
} from "../../../src/tools/namespace.ts";

describe("namespacedToolName — construction", () => {
  test("builds `ws_<id>/<name>` for valid inputs", () => {
    expect(namespacedToolName("ws_helix", "crm.search")).toBe("ws_helix/crm.search");
    expect(namespacedToolName("ws_user_alice", "gmail.send")).toBe("ws_user_alice/gmail.send");
  });

  test("throws on empty wsId — fail-loud, no silent default (Stage 1 lesson 3)", () => {
    expect(() => namespacedToolName("", "foo")).toThrow(InvalidNamespacedToolNameInput);
  });

  test("throws on path-traversal wsId — defense-in-depth at construction site", () => {
    // The construction site validates against WORKSPACE_ID_RE so a
    // traversal-shaped wsId can't sneak through to whoever consumes
    // the resulting namespaced name.
    expect(() => namespacedToolName("../etc", "foo")).toThrow(InvalidNamespacedToolNameInput);
  });

  test("throws on whitespace wsId", () => {
    // `ws helix` fails the regex; would have been a quiet downstream
    // bug if the primitive just stringified its inputs.
    expect(() => namespacedToolName("ws helix", "foo")).toThrow(InvalidNamespacedToolNameInput);
  });

  test("throws on missing-prefix wsId", () => {
    // `helix` (no `ws_`) is structurally invalid — would let a
    // non-workspace id flow into a workspace-bound code path.
    expect(() => namespacedToolName("helix", "foo")).toThrow(InvalidNamespacedToolNameInput);
  });

  test("throws on empty tool name", () => {
    expect(() => namespacedToolName("ws_helix", "")).toThrow(InvalidNamespacedToolNameInput);
  });

  test("error carries structured reason and input fields", () => {
    try {
      namespacedToolName("../evil", "foo");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidNamespacedToolNameInput);
      const e = err as InvalidNamespacedToolNameInput;
      expect(e.name).toBe("InvalidNamespacedToolNameInput");
      expect(e.wsId).toBe("../evil");
      expect(e.reason).toBe("invalid_wsid");
    }
  });
});

describe("parseNamespacedToolName — parsing", () => {
  test("parses a valid namespaced name", () => {
    expect(parseNamespacedToolName("ws_helix/crm.search")).toEqual({
      wsId: "ws_helix",
      toolName: "crm.search",
    });
  });

  test("takes the FIRST `/` as separator — tool names may contain `/`", () => {
    // Documented contract: future tool sources (resources-as-tools)
    // may surface names containing `/`. Splitting on first `/` keeps
    // that viable. If this changes, the orchestrator's dispatch must
    // change in lockstep.
    expect(parseNamespacedToolName("ws_helix/foo/bar")).toEqual({
      wsId: "ws_helix",
      toolName: "foo/bar",
    });
  });

  test("throws on non-namespaced input — no fallback to current workspace (Stage 1 lesson 3)", () => {
    // The failure mode this pins: a silent "if no slash, assume
    // current workspace" defaulting that would let untyped tool names
    // run against the wrong workspace.
    expect(() => parseNamespacedToolName("crm.search")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty input", () => {
    expect(() => parseNamespacedToolName("")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty workspace component (`ws_/foo`)", () => {
    // `ws_/foo` after splitting at first `/` yields `wsId=""`; the
    // primitive must reject rather than produce an invalid scope.
    expect(() => parseNamespacedToolName("ws_/foo")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty tool name (`ws_helix/`)", () => {
    expect(() => parseNamespacedToolName("ws_helix/")).toThrow(UnknownNamespacedToolName);
  });

  test("throws when workspace component fails WORKSPACE_ID_RE", () => {
    // `..` after split yields an invalid wsId that the orchestrator
    // would otherwise have to defend against itself; the primitive
    // catches it.
    expect(() => parseNamespacedToolName("../foo/bar")).toThrow(UnknownNamespacedToolName);
  });

  test("error carries structured reason and input fields", () => {
    try {
      parseNamespacedToolName("crm.search");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownNamespacedToolName);
      const e = err as UnknownNamespacedToolName;
      expect(e.name).toBe("UnknownNamespacedToolName");
      expect(e.input).toBe("crm.search");
      expect(e.reason).toBe("missing_separator");
    }
  });
});

describe("round-trip property", () => {
  test("`parseNamespacedToolName(namespacedToolName(w, n))` round-trips for valid pairs", () => {
    // Sampling the space of valid inputs that real call sites will
    // produce. The produced string must also match the documented
    // shape regex — that's a second invariant that downstream
    // consumers (e.g. orchestrator dispatch) may rely on.
    const cases: Array<{ wsId: string; toolName: string }> = [
      { wsId: "ws_helix", toolName: "crm.search" },
      { wsId: "ws_user_alice", toolName: "gmail.send" },
      { wsId: "ws_a", toolName: "x" },
      { wsId: "ws_ABC_123", toolName: "search-records" },
      { wsId: "ws_workspace_with_underscores", toolName: "tool.with.dots" },
      // First-slash semantics: a tool name with `/` must round-trip
      // through the primitive without being re-split.
      { wsId: "ws_helix", toolName: "foo/bar" },
      { wsId: "ws_helix", toolName: "a/b/c/d" },
    ];
    const SHAPE_RE = /^ws_[a-zA-Z0-9_-]+\/[^/].*$|^ws_[a-zA-Z0-9_-]+\/[^/]$/;
    // Looser shape check that admits the embedded-slash cases:
    const SHAPE_RE_LOOSE = /^ws_[a-zA-Z0-9_-]+\/.+$/;
    for (const { wsId, toolName } of cases) {
      const s = namespacedToolName(wsId, toolName);
      expect(s).toMatch(SHAPE_RE_LOOSE);
      expect(parseNamespacedToolName(s)).toEqual({ wsId, toolName });
      // Acknowledge SHAPE_RE exists to silence unused-binding warnings
      // from biome — kept for documentation of the strict no-embedded-
      // slash form, which the embedded-slash cases intentionally widen.
      void SHAPE_RE;
    }
  });

  test("produced string matches the canonical `/^ws_[a-zA-Z0-9_-]+\\/[^/]+$/` for slash-free tool names", () => {
    // Tight regex applies only when the tool name itself has no `/`.
    const cases: Array<[string, string]> = [
      ["ws_helix", "crm.search"],
      ["ws_user_alice", "gmail.send"],
      ["ws_a", "x"],
    ];
    const RE = /^ws_[a-zA-Z0-9_-]+\/[^/]+$/;
    for (const [wsId, toolName] of cases) {
      expect(namespacedToolName(wsId, toolName)).toMatch(RE);
    }
  });
});
