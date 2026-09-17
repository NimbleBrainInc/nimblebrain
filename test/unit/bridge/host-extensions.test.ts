/**
 * The host context carries what any app may use, and nothing that belongs to
 * one app. Every mounted app receives it, and a `host-context-changed` push
 * reaches all of them, so a key only one app reads is both a leak of that
 * app's data and a re-render of every other app when it moves.
 */

import { describe, expect, test } from "bun:test";
import {
  buildHostContext,
  buildHostExtensions,
} from "../../../web/src/bridge/host-extensions.ts";
const WORKSPACE = { id: "ws_example00000000", name: "Example", isPersonal: false };

/** Keys the host context is allowed to carry. */
const ALLOWED = new Set(["workspace", "theme", "styles"]);

describe("host context", () => {
  test("handshake extensions carry no app-specific key", () => {
    const keys = Object.keys(buildHostExtensions(WORKSPACE));
    expect(keys.filter((k) => !ALLOWED.has(k))).toEqual([]);
  });

  test("a host-context-changed payload carries no app-specific key", () => {
    const keys = Object.keys(buildHostContext("dark", WORKSPACE));
    expect(keys.filter((k) => !ALLOWED.has(k))).toEqual([]);
    expect(keys).not.toContain("streamingConversationIds");
  });
});
