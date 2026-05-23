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
import { parseNamespacedToolName } from "../src/lib/namespaced-tool";

describe("parseNamespacedToolName (web)", () => {
  test("parses ws_<id>/<tool> cleanly", () => {
    expect(parseNamespacedToolName("ws_helix/crm.search")).toEqual({
      wsId: "ws_helix",
      toolName: "crm.search",
    });
  });

  test("first `/` is the separator — tool names may contain `/`", () => {
    // Mirrors the platform primitive: `ws_helix/foo/bar` → toolName "foo/bar"
    expect(parseNamespacedToolName("ws_helix/foo/bar")).toEqual({
      wsId: "ws_helix",
      toolName: "foo/bar",
    });
  });

  test("returns null on missing separator", () => {
    expect(parseNamespacedToolName("crm.search")).toBeNull();
  });

  test("returns null on empty workspace component", () => {
    expect(parseNamespacedToolName("/crm.search")).toBeNull();
  });

  test("returns null on empty tool component", () => {
    expect(parseNamespacedToolName("ws_helix/")).toBeNull();
  });

  test("returns null on invalid wsId (no `ws_` prefix)", () => {
    expect(parseNamespacedToolName("helix/crm.search")).toBeNull();
  });

  test("returns null on path-traversal-style wsId", () => {
    // The WORKSPACE_ID_RE rejects `..` / `/` in the wsId segment.
    expect(parseNamespacedToolName("ws_../etc/passwd/foo")).toBeNull();
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
