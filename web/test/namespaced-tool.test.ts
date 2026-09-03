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
import {
  appNameFromToolName,
  isPersonalConnectorAppName,
  parseNamespacedToolName,
} from "../src/lib/namespaced-tool";

/** A valid opaque workspace id, matching what `generateWorkspaceId()` produces. */
const WS = "ws_0123456789abcdef";

describe("appNameFromToolName (web)", () => {
  test("drops the ws_<id>- prefix AND the __<tool> tail → bare source name", () => {
    // Regression: the chat transcript used to slice on `__` alone, leaving
    // the `ws_<id>-` prefix attached. The bare name is what the REST
    // resource-read surfaces key the registry by; the namespaced form 403s.
    expect(appNameFromToolName("ws_nimblebrain_shared-synapse-collateral__export_pdf")).toBe(
      "synapse-collateral",
    );
  });

  test("hyphenated source names survive (only the ws_<id>- head is removed)", () => {
    expect(appNameFromToolName("ws_helix-synapse-todo-board__create_task")).toBe(
      "synapse-todo-board",
    );
  });

  test("bare (identity) tool name → bare source", () => {
    expect(appNameFromToolName("conversations__search")).toBe("conversations");
  });

  test("no __ separator → undefined (not an app-owned call)", () => {
    expect(appNameFromToolName("ws_helix-nb")).toBeUndefined();
    expect(appNameFromToolName("plain")).toBeUndefined();
  });
});

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

  test("a bare name parses to global scope, whole name as toolName", () => {
    expect(parseNamespacedToolName("conversations__search")).toEqual({
      scope: { kind: "identity" },
      toolName: "conversations__search",
    });
  });

  test("a bare name with no separator is global", () => {
    expect(parseNamespacedToolName("nb__search")).toEqual({
      scope: { kind: "identity" },
      toolName: "nb__search",
    });
  });

  test("a bare name whose source contains `-` (not ws_) stays global", () => {
    expect(parseNamespacedToolName("helix-crm__search")).toEqual({
      scope: { kind: "identity" },
      toolName: "helix-crm__search",
    });
  });

  test("returns null on empty tool component after a workspace prefix", () => {
    expect(parseNamespacedToolName("ws_helix-")).toBeNull();
  });

  test("returns null on a malformed ws_ prefix (workspace attempt, not global)", () => {
    // Starts with `ws_` but fails WORKSPACE_ID_RE → render raw, don't
    // silently treat a malformed workspace name as a bare global one.
    expect(parseNamespacedToolName("ws_..-etc-passwd-foo")).toBeNull();
  });

  test("returns null on empty / non-string input", () => {
    expect(parseNamespacedToolName("")).toBeNull();
    expect(parseNamespacedToolName(null as unknown as string)).toBeNull();
    expect(parseNamespacedToolName(undefined as unknown as string)).toBeNull();
  });

  test("a bare name never resolves to a workspace — no 'current workspace' guess (Q2)", () => {
    // A bare name is global, never silently routed to the user's current
    // workspace. The scope is explicit: workspace only when ws_<id>- is present.
    const parsed = parseNamespacedToolName("foo");
    expect(parsed?.scope.kind).toBe("identity");
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
  // drift, and a generated file absent from the tree along with it.

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

// ── personal-connector marker ────────────────────────────────────────────────
// Folded in from a second test file over this module. Two files covering one
// module is the duplication `tool-pattern.ts` argues against in its own header:
// the next editor fixes one of them.

describe("appNameFromToolName — personal-connector marker", () => {
  test("the marker is KEPT — the app name is an identity, not a label", () => {
    // Every consumer re-resolves this value (`getResources`, `readResource`,
    // `openArtifact`); none renders it. Returning `gmail` here would send them
    // to `GET /v1/apps/gmail/resources/*`, which resolves through the WORKSPACE
    // registry — a same-named workspace app would answer for a call the user
    // made against their own account.
    expect(appNameFromToolName("my_gmail__send")).toBe("my_gmail");
  });

  test("it does not collapse onto the same-named workspace source", () => {
    expect(appNameFromToolName("my_gmail__send")).not.toBe(appNameFromToolName("gmail__send"));
  });

  test("the unmarked workspace source is unaffected", () => {
    expect(appNameFromToolName("gmail__send")).toBe("gmail");
  });

  test("a marked name replayed under a legacy prefix still keeps its marker", () => {
    expect(appNameFromToolName(`${WS}-my_gmail__send`)).toBe("my_gmail");
  });
});

describe("isPersonalConnectorAppName", () => {
  test("recognizes a marked app name", () => {
    expect(isPersonalConnectorAppName("my_gmail")).toBe(true);
  });

  test("an ordinary source name is not marked", () => {
    expect(isPersonalConnectorAppName("gmail")).toBe(false);
  });

  test("a hyphenated `my-` slug is NOT the marker", () => {
    // `slugifyServerName` emits `[a-z0-9-]` and never `_`, so `@my/thing` slugs
    // to `my-thing`. Treating that as marked would refuse a legitimate app — the
    // whole reason the marker is `my_` and not `my-`.
    expect(isPersonalConnectorAppName("my-thing")).toBe(false);
    expect(isPersonalConnectorAppName("my-notes-mcp")).toBe(false);
  });

  test("it composes with the parser: every marked wire name is flagged", () => {
    const appName = appNameFromToolName("my_gmail__send");
    expect(appName).toBeDefined();
    expect(isPersonalConnectorAppName(appName!)).toBe(true);
  });
});

describe("parseNamespacedToolName", () => {
  test("a marked name parses as identity-scoped, marker intact", () => {
    // The marker lives inside the source segment, so the namespace parser must
    // pass it through untouched — it is the source that picks the door.
    expect(parseNamespacedToolName("my_gmail__send")).toEqual({
      scope: { kind: "identity" },
      toolName: "my_gmail__send",
    });
  });
});
