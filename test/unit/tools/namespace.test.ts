/**
 * Unit tests for `src/tools/namespace.ts`.
 *
 * Pins the primitive's contract for Stage 2 of the cross-workspace
 * refactor. Failure modes covered (in order of likelihood we'd silently
 * regress):
 *
 *  - `parseNamespacedToolName` silently falling back to "current
 *    workspace" on a non-namespaced input (the Stage 1 lesson 3
 *    failure mode).
 *  - `namespacedToolName` accepting a wsId carrying path traversal
 *    or whitespace — the Stage 2 invariant lift that motivates the
 *    `WORKSPACE_ID_RE` import.
 *  - Embedded `-` in tool name being mis-split (we take the FIRST `-`
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
  test("builds `ws_<id>-<name>` for valid inputs", () => {
    expect(namespacedToolName("ws_helix", "crm__search")).toBe("ws_helix-crm__search");
    expect(namespacedToolName("ws_user_alice", "gmail__send")).toBe("ws_user_alice-gmail__send");
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
  test("parses a valid workspace-scoped name", () => {
    expect(parseNamespacedToolName("ws_helix-crm__search")).toEqual({
      scope: { kind: "workspace", wsId: "ws_helix" },
      toolName: "crm__search",
    });
  });

  test("takes the FIRST `-` as separator — tool names may contain `-`", () => {
    // Documented contract: tool names can themselves contain `-` (e.g.
    // `crm-tool__search`). Workspace ids can't contain `-` per
    // WORKSPACE_ID_PATTERN, so the first `-` is unambiguously the
    // scope/tool boundary.
    expect(parseNamespacedToolName("ws_helix-foo-bar")).toEqual({
      scope: { kind: "workspace", wsId: "ws_helix" },
      toolName: "foo-bar",
    });
  });

  test("throws on empty input", () => {
    expect(() => parseNamespacedToolName("")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty tool name after a workspace prefix (`ws_helix-`)", () => {
    expect(() => parseNamespacedToolName("ws_helix-")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on a malformed ws_ prefix — a workspace attempt, not a bare name", () => {
    // A leading `ws_`-prefixed segment that fails WORKSPACE_ID_RE is a
    // malformed/hostile workspace id (typo, traversal, cross-tenant
    // probe). Surface it rather than silently treating it as global.
    expect(() => parseNamespacedToolName("ws_BAD!-foo")).toThrow(UnknownNamespacedToolName);
  });

  test("malformed ws_ prefix carries reason invalid_wsid", () => {
    try {
      parseNamespacedToolName("ws_BAD!-foo");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownNamespacedToolName);
      expect((err as UnknownNamespacedToolName).reason).toBe("invalid_wsid");
    }
  });
});

describe("round-trip property", () => {
  test("`parseNamespacedToolName(namespacedToolName(w, n))` round-trips for valid pairs", () => {
    // Sampling the space of valid inputs that real call sites will
    // produce. Produced strings must also be LLM-provider compatible
    // (`[a-zA-Z0-9_-]{1,128}`) — that's why `-` is the separator.
    const cases: Array<{ wsId: string; toolName: string }> = [
      { wsId: "ws_helix", toolName: "crm__search" },
      { wsId: "ws_user_alice", toolName: "gmail__send" },
      { wsId: "ws_a", toolName: "x" },
      { wsId: "ws_ABC_123", toolName: "search_records" },
      { wsId: "ws_workspace_with_underscores", toolName: "tool_name" },
      // First-`-` semantics: a tool name with embedded `-` must
      // round-trip through the primitive without being re-split.
      { wsId: "ws_helix", toolName: "foo-bar" },
      { wsId: "ws_helix", toolName: "a-b-c-d" },
    ];
    // Shape regex matches the canonical form. Tool names can contain
    // any of `[a-zA-Z0-9_-]` (LLM-compatible chars).
    const SHAPE_RE = /^ws_[a-zA-Z0-9_]+-[a-zA-Z0-9_-]+$/;
    for (const { wsId, toolName } of cases) {
      const s = namespacedToolName(wsId, toolName);
      expect(s).toMatch(SHAPE_RE);
      expect(parseNamespacedToolName(s)).toEqual({
        scope: { kind: "workspace", wsId },
        toolName,
      });
    }
  });

  test("produced string matches the LLM provider regex `[a-zA-Z0-9_-]{1,128}`", () => {
    // The whole point of using `-` (not `/`) as the separator: every
    // produced name must pass the upstream provider's tool-name
    // validator. Regressing this would block tool registration with
    // OpenAI/Anthropic/etc. at the API boundary.
    const cases: Array<[string, string]> = [
      ["ws_helix", "crm__search"],
      ["ws_user_alice", "gmail__send"],
      ["ws_a", "x"],
    ];
    const PROVIDER_RE = /^[a-zA-Z0-9_-]{1,128}$/;
    for (const [wsId, toolName] of cases) {
      expect(namespacedToolName(wsId, toolName)).toMatch(PROVIDER_RE);
    }
  });
});

describe("global scope (bare names)", () => {
  test("a bare platform tool parses to global scope, whole name as toolName", () => {
    // No `ws_<id>-` prefix → global singleton. The whole name is the tool
    // name (nothing to strip). The orchestrator validates the source
    // against the kernel global-source set.
    expect(parseNamespacedToolName("nb__search")).toEqual({
      scope: { kind: "global" },
      toolName: "nb__search",
    });
  });

  test("a bare identity-owned app tool parses to global scope", () => {
    expect(parseNamespacedToolName("conversations__search")).toEqual({
      scope: { kind: "global" },
      toolName: "conversations__search",
    });
  });

  test("a bare name whose source contains `-` stays global (whole name preserved)", () => {
    // `synapse-crm` doesn't start with `ws_`, so the leading `-` is NOT a
    // workspace boundary — the entire name is the (global) tool name. The
    // orchestrator later rejects it because `synapse-crm` isn't a global
    // source; the parser doesn't pre-judge that.
    expect(parseNamespacedToolName("synapse-crm__search")).toEqual({
      scope: { kind: "global" },
      toolName: "synapse-crm__search",
    });
  });

  test("no `me-` prefix exists — `me-foo` is just a bare global name", () => {
    // The old design had a `me` sentinel; bare-global dropped it. `me-foo`
    // is now simply a bare name (head `me` isn't `ws_`-prefixed).
    expect(parseNamespacedToolName("me-foo")).toEqual({
      scope: { kind: "global" },
      toolName: "me-foo",
    });
  });

  test("a workspace prefix still wins over global — ws_ takes the route", () => {
    expect(parseNamespacedToolName("ws_helix-nb__search")).toEqual({
      scope: { kind: "workspace", wsId: "ws_helix" },
      toolName: "nb__search",
    });
  });
});
