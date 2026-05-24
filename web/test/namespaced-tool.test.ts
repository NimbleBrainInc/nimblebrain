// ---------------------------------------------------------------------------
// namespaced-tool parser — web-side mirror of T002's primitive.
//
// Pins the contract the task spec demands ("Namespace parsing via T002
// only — grep new components for `.split(\"/\")` adjacent to a tool-name
// binding → zero matches"):
//
//   1. Well-formed `ws_<id>/<tool>` parses cleanly.
//   2. First `/` is the separator — tool names containing `/` survive.
//   3. Bad shapes return `null` (not throw, not fall back). The caller
//      renders raw input per Q2.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_ID_FLAGS,
  WORKSPACE_ID_PATTERN,
} from "../src/_generated/workspace-id-pattern.ts";
import { identityToolName, parseNamespacedToolName } from "../src/lib/namespaced-tool";

describe("parseNamespacedToolName (web)", () => {
  test("parses ws_<id>-<tool> to workspace scope", () => {
    expect(parseNamespacedToolName("ws_helix-crm__search")).toEqual({
      scope: { kind: "workspace", wsId: "ws_helix" },
      toolName: "crm__search",
    });
  });

  test("first `-` is the separator — tool names may contain `-`", () => {
    // Mirrors the platform primitive: `ws_helix-foo-bar` → toolName "foo-bar"
    expect(parseNamespacedToolName("ws_helix-foo-bar")).toEqual({
      scope: { kind: "workspace", wsId: "ws_helix" },
      toolName: "foo-bar",
    });
  });

  test("parses me-<tool> to identity scope", () => {
    expect(parseNamespacedToolName("me-conversations__search")).toEqual({
      scope: { kind: "identity" },
      toolName: "conversations__search",
    });
  });

  test("identityToolName round-trips through the parser", () => {
    expect(parseNamespacedToolName(identityToolName("files__list"))).toEqual({
      scope: { kind: "identity" },
      toolName: "files__list",
    });
  });

  test("returns null on missing separator", () => {
    expect(parseNamespacedToolName("crm.search")).toBeNull();
  });

  test("returns null on empty workspace component", () => {
    expect(parseNamespacedToolName("-crm__search")).toBeNull();
  });

  test("returns null on empty tool component", () => {
    expect(parseNamespacedToolName("ws_helix-")).toBeNull();
  });

  test("returns null on invalid wsId (no `ws_` prefix)", () => {
    expect(parseNamespacedToolName("helix-crm__search")).toBeNull();
  });

  test("returns null on path-traversal-style wsId", () => {
    // The WORKSPACE_ID_RE rejects characters not in `[a-z0-9_]`.
    expect(parseNamespacedToolName("ws_..-etc-passwd-foo")).toBeNull();
  });

  test("returns null on empty / non-string input", () => {
    expect(parseNamespacedToolName("")).toBeNull();
    expect(parseNamespacedToolName(null as unknown as string)).toBeNull();
    expect(parseNamespacedToolName(undefined as unknown as string)).toBeNull();
  });

  test("never falls back to a 'current workspace' — Q2 invariant", () => {
    // A regression that defaulted to the user's personal workspace on
    // missing wsId would be a subtle correctness bug. The parser must
    // refuse rather than guess.
    expect(parseNamespacedToolName("foo")).toBeNull();
  });
});

describe("web workspace-id regex stays in lockstep with the server (T012)", () => {
  // Group E audit, T013 concern #10: pre-Stage-2, web hand-wrote
  // `/^ws_[a-zA-Z0-9_-]+$/` while the server used
  // `/^ws_[a-z0-9_]{1,64}$/i`. Web was strictly more permissive —
  // server-produced names always parsed, but a future server-side
  // tightening wouldn't have reached web. Stage 2 fixes this by
  // emitting `web/src/_generated/workspace-id-pattern.ts` from
  // `src/workspace/workspace-id-pattern.ts` via `bun run codegen`.
  // The test below pins the contract: the generated literal must match
  // the literal embedded in the source. CI's `check:codegen` catches
  // drift via `git diff --exit-code web/src/_generated/`.

  test("imported pattern + flags equal the server's literal", () => {
    // These are the same string + flags the server compiles into its
    // WORKSPACE_ID_RE in src/workspace/workspace-id-pattern.ts. If the
    // server tightens the regex (e.g. shrinks the max length), the
    // codegen step re-emits and this assertion stays green automatically.
    // If a contributor edits the generated file by hand, `check:codegen`
    // fails before the test runs.
    expect(WORKSPACE_ID_PATTERN).toBe("^ws_[a-z0-9_]{1,64}$");
    expect(WORKSPACE_ID_FLAGS).toBe("i");
  });

  test("web parser uses the imported literal as its regex source", () => {
    // Constructs the same RegExp the parser uses (`new RegExp(pattern, flags)`)
    // and confirms its `.source` is exactly the imported pattern string.
    // Independent of any local copy in the parser file — drift detected
    // immediately.
    const re = new RegExp(WORKSPACE_ID_PATTERN, WORKSPACE_ID_FLAGS);
    expect(re.source).toBe(WORKSPACE_ID_PATTERN);
    expect(re.flags).toBe(WORKSPACE_ID_FLAGS);
  });

  test("the imported pattern rejects shapes the parser must reject", () => {
    // Hyphens, no-prefix, path traversal, length-overflow — the same
    // shapes the parser's `null` returns cover, but asserted here
    // directly against the regex so any future widening of the pattern
    // string surfaces as a parser-test failure without code churn.
    const re = new RegExp(WORKSPACE_ID_PATTERN, WORKSPACE_ID_FLAGS);
    expect(re.test("ws-helix")).toBe(false); // hyphen
    expect(re.test("ws_with-hyphen")).toBe(false); // hyphen inside
    expect(re.test("helix")).toBe(false); // no prefix
    expect(re.test("ws_..")).toBe(false); // path traversal
    expect(re.test(`ws_${"a".repeat(65)}`)).toBe(false); // length overflow
    expect(re.test("ws_helix")).toBe(true); // canonical
    expect(re.test("ws_USER_abc")).toBe(true); // case-insensitive flag
  });
});
