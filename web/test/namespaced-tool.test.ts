// ---------------------------------------------------------------------------
// Wire tool-name helpers (lib/namespaced-tool): the source/app name a wire
// name carries, and the personal-connector marker.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { appNameFromToolName, isPersonalConnectorAppName } from "../src/lib/namespaced-tool";

describe("appNameFromToolName", () => {
  test("the source before `__`, hyphens and all", () => {
    expect(appNameFromToolName("conversations__search")).toBe("conversations");
    expect(appNameFromToolName("synapse-todo-board__create_task")).toBe("synapse-todo-board");
  });

  test("no __ separator → undefined (not an app-owned call)", () => {
    expect(appNameFromToolName("plain")).toBeUndefined();
    expect(appNameFromToolName("__leading")).toBeUndefined();
  });
});

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

  test("every marked wire name is flagged", () => {
    const appName = appNameFromToolName("my_gmail__send");
    expect(appName).toBeDefined();
    expect(isPersonalConnectorAppName(appName!)).toBe(true);
  });
});
