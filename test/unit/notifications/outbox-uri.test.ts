/**
 * Expanding `<resource>{?cursor,maxEvents,maxAgeMs}`.
 *
 * The declaration parser already refuses a URI carrying a query or a fragment,
 * so appending is unambiguous — these tests pin the encoding, and the one
 * property the runtime must never lose: a cursor goes back exactly as it came.
 */

import { describe, expect, test } from "bun:test";
import { NOTIFICATION_RETENTION_DAYS } from "../../../src/notifications/store.ts";
import {
  NOTIFICATION_REPLAY_MAX_AGE_MS,
  outboxReadUri,
} from "../../../src/notifications/outbox-uri.ts";

describe("outboxReadUri", () => {
  test("omits the cursor on the bootstrap read", () => {
    expect(outboxReadUri("acme://notifications", { maxEvents: 100, maxAgeMs: 5 })).toBe(
      "acme://notifications?maxEvents=100&maxAgeMs=5",
    );
  });

  test("round-trips a cursor whatever is in it", () => {
    // Cursors are opaque server tokens. The real outbox library packs an epoch
    // and a snapshot horizon into a base64url blob; a `+`, `/` or `=` in one
    // must survive the query string rather than be silently re-interpreted.
    const cursor = "a+b/c=d&e f";
    const uri = outboxReadUri("acme://notifications", {
      cursor,
      maxEvents: 10,
      maxAgeMs: 1,
    });
    const query = new URLSearchParams(uri.split("?", 2)[1]);
    expect(query.get("cursor")).toBe(cursor);
  });
});

describe("the replay bound", () => {
  test("is the inbox's own retention", () => {
    // Derived rather than chosen beside it: an event older than the window the
    // inbox keeps is history, not news, and two numbers next to each other are
    // two numbers that drift.
    expect(NOTIFICATION_REPLAY_MAX_AGE_MS).toBe(NOTIFICATION_RETENTION_DAYS * 86_400_000);
  });
});
