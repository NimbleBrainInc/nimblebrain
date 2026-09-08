/**
 * Workspace addresses in the web shell.
 *
 * The slug rule had two inline copies before this module existed, so the
 * property worth pinning is not the string format — it is that the id is
 * carried through opaquely. A workspace id is generated, not derived from a
 * name, so anything here that tried to be clever about its contents would be
 * inventing a meaning the id does not have.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  notificationInboxUrl,
  workspaceSlug,
  workspaceUrl,
} from "../../../src/workspace/workspace-url.ts";

const ORIGIN_ENV = "NB_WEB_URL";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ORIGIN_ENV];
  process.env[ORIGIN_ENV] = "https://tenant.example";
});

afterEach(() => {
  if (saved === undefined) delete process.env[ORIGIN_ENV];
  else process.env[ORIGIN_ENV] = saved;
});

describe("workspaceSlug", () => {
  test("strips the ws_ prefix and nothing else", () => {
    expect(workspaceSlug("ws_a1b2c3d4")).toBe("a1b2c3d4");
  });

  test("leaves an id that does not carry the prefix alone", () => {
    // Not a validator. An id without the prefix is not this function's to
    // reject — `WORKSPACE_ID_RE` owns that, at the doors where ids arrive.
    expect(workspaceSlug("a1b2c3d4")).toBe("a1b2c3d4");
  });

  test("strips only a leading occurrence", () => {
    expect(workspaceSlug("ws_ws_nested")).toBe("ws_nested");
  });
});

describe("workspaceUrl", () => {
  test("roots the path under the workspace", () => {
    expect(workspaceUrl("ws_team", "/settings/connectors")).toBe(
      "https://tenant.example/w/team/settings/connectors",
    );
  });
});

describe("notificationInboxUrl", () => {
  test("addresses one item by query parameter", () => {
    expect(notificationInboxUrl("ws_team", "acme:evt_1")).toBe(
      "https://tenant.example/w/team/notifications?item=acme%3Aevt_1",
    );
  });

  test("encodes an id whose halves carry URL metacharacters", () => {
    // Both halves are a server's own strings: the source name and the event id.
    // Neither is constrained to anything URL-safe, so the encode is load-bearing
    // rather than decorative — an unescaped `&` would truncate the parameter.
    expect(notificationInboxUrl("ws_team", "acme/mcp:evt?a=1&b=2")).toBe(
      "https://tenant.example/w/team/notifications?item=acme%2Fmcp%3Aevt%3Fa%3D1%26b%3D2",
    );
  });

  test("falls back to the inbox itself when no item is named", () => {
    expect(notificationInboxUrl("ws_team")).toBe("https://tenant.example/w/team/notifications");
  });
});
