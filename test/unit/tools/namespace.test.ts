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
 *  - Embedded `-` in tool name being mis-split (we take the FIRST `-`
 *    as the separator; this contract is asserted explicitly).
 *  - Round-trip property: anything `namespacedToolName` produces must
 *    parse back to the same `{wsId, toolName}`. If this breaks, the
 *    primitive is internally inconsistent.
 */

import { describe, expect, test } from "bun:test";
import {
  IDENTITY_SCOPE,
  identityToolName,
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

  test("throws on non-namespaced input — no fallback to current workspace (Stage 1 lesson 3)", () => {
    // The failure mode this pins: a silent "if no separator, assume
    // current workspace" defaulting that would let untyped tool names
    // run against the wrong workspace.
    expect(() => parseNamespacedToolName("crm.search")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty input", () => {
    expect(() => parseNamespacedToolName("")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty workspace component (`-foo`)", () => {
    // `-foo` after splitting at first `-` yields `wsId=""`; the
    // primitive must reject rather than produce an invalid scope.
    expect(() => parseNamespacedToolName("-foo")).toThrow(UnknownNamespacedToolName);
  });

  test("throws on empty tool name (`ws_helix-`)", () => {
    expect(() => parseNamespacedToolName("ws_helix-")).toThrow(UnknownNamespacedToolName);
  });

  test("throws when workspace component fails WORKSPACE_ID_RE", () => {
    // `..` before the first `-` yields an invalid wsId that the
    // orchestrator would otherwise have to defend against itself; the
    // primitive catches it.
    expect(() => parseNamespacedToolName("..-foo-bar")).toThrow(UnknownNamespacedToolName);
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

describe("identity scope (`me-<tool>`)", () => {
  test("identityToolName builds `me-<name>`", () => {
    expect(identityToolName("conversations__search")).toBe("me-conversations__search");
    expect(IDENTITY_SCOPE).toBe("me");
  });

  test("identityToolName throws on empty name", () => {
    expect(() => identityToolName("")).toThrow(InvalidNamespacedToolNameInput);
  });

  test("parses an identity-scoped name to the identity scope", () => {
    expect(parseNamespacedToolName("me-conversations__search")).toEqual({
      scope: { kind: "identity" },
      toolName: "conversations__search",
    });
  });

  test("identity scope takes the FIRST `-` — tool names may contain `-`", () => {
    expect(parseNamespacedToolName("me-foo-bar")).toEqual({
      scope: { kind: "identity" },
      toolName: "foo-bar",
    });
  });

  test("`me` is unambiguous against workspace ids (no ws_ prefix)", () => {
    // A workspace id must match ^ws_..., which `me` can never satisfy,
    // so the leading `me` segment is always the identity sentinel.
    const parsed = parseNamespacedToolName("me-x");
    expect(parsed.scope.kind).toBe("identity");
  });

  test("throws on empty tool name (`me-`)", () => {
    expect(() => parseNamespacedToolName("me-")).toThrow(UnknownNamespacedToolName);
  });

  test("identity round-trips", () => {
    const s = identityToolName("files__list");
    expect(parseNamespacedToolName(s)).toEqual({
      scope: { kind: "identity" },
      toolName: "files__list",
    });
  });

  test("a non-me, non-ws_ scope is rejected with reason invalid_scope", () => {
    try {
      parseNamespacedToolName("helix-foo");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownNamespacedToolName);
      expect((err as UnknownNamespacedToolName).reason).toBe("invalid_scope");
    }
  });
});
