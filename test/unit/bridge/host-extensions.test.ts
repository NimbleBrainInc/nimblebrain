/**
 * The host context carries what any app may use, and nothing that belongs to
 * one app. Every mounted app receives it, and a `host-context-changed` push
 * reaches all of them, so a key only one app reads is both a leak of that
 * app's data and a re-render of every other app when it moves.
 */

import { describe, expect, test } from "bun:test";
import { buildHostContext, buildHostExtensions } from "../../../web/src/bridge/host-extensions.ts";

const WORKSPACE = { id: "ws_example00000000", name: "Example" };

const UPLOADS = { maxFileSize: 26_214_400, maxTotalSize: 104_857_600 };

/**
 * Keys the host context is allowed to carry. `uploads` is the instance's
 * picker limits, which the host enforces for every app that picks a file.
 */
const ALLOWED = new Set(["workspace", "uploads", "theme", "styles"]);

describe("host context", () => {
  test("handshake extensions carry no app-specific key", () => {
    const keys = Object.keys(buildHostExtensions(WORKSPACE, undefined, UPLOADS));
    expect(keys.filter((k) => !ALLOWED.has(k))).toEqual([]);
  });

  test("a host-context-changed payload carries no app-specific key", () => {
    const keys = Object.keys(buildHostContext("dark", WORKSPACE, undefined, UPLOADS));
    expect(keys.filter((k) => !ALLOWED.has(k))).toEqual([]);
    expect(keys).not.toContain("streamingConversationIds");
  });

  test("the picker's upload limits reach the app as `uploads`", () => {
    expect(buildHostExtensions(WORKSPACE, undefined, UPLOADS).uploads).toEqual(UPLOADS);
    expect(buildHostExtensions(WORKSPACE)).not.toHaveProperty("uploads");
  });
});
