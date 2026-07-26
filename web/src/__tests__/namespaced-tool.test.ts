import { describe, expect, test } from "bun:test";
import {
  appNameFromToolName,
  isPersonalConnectorAppName,
  parseNamespacedToolName,
} from "../lib/namespaced-tool";

// A valid opaque workspace id, matching what `generateWorkspaceId()` produces.
const WS = "ws_0123456789abcdef";

describe("appNameFromToolName", () => {
  test("a bare wire name yields its source segment", () => {
    expect(appNameFromToolName("synapse-collateral__get_doc")).toBe("synapse-collateral");
  });

  test("a replayed legacy name drops the workspace prefix", () => {
    // Transcripts still hold the retired form; the app name is the post-prefix
    // source, never `ws_<id>-synapse-collateral` (which fails `hasSource()`).
    expect(appNameFromToolName(`${WS}-synapse-collateral__get_doc`)).toBe("synapse-collateral");
  });

  test("a name with no `__` owns no app", () => {
    expect(appNameFromToolName("conversations")).toBeUndefined();
  });

  describe("personal-connector marker", () => {
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
