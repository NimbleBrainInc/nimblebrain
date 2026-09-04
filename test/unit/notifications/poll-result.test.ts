/**
 * The poll answer is re-derived from `unknown`, and the asymmetry with the
 * envelope parser is the point: a bad envelope costs one event, a bad answer
 * costs the poll — because there is no position in it the runtime may trust.
 */

import { describe, expect, test } from "bun:test";
import {
  parseOutboxPollBody,
  parseOutboxPollResult,
} from "../../../src/notifications/poll-result.ts";

describe("parseOutboxPollResult", () => {
  test("accepts the documented shape", () => {
    expect(
      parseOutboxPollResult({
        events: [{ eventId: "evt_1" }],
        cursor: "opaque",
        truncated: true,
        hasMore: true,
        nextPollMs: 30_000,
      }),
    ).toEqual({
      events: [{ eventId: "evt_1" }],
      cursor: "opaque",
      truncated: true,
      hasMore: true,
      nextPollMs: 30_000,
    });
  });

  test("treats every optional field as absent-means-no-opinion", () => {
    expect(parseOutboxPollResult({ events: [] })).toEqual({
      events: [],
      truncated: false,
      hasMore: false,
    });
  });

  test("carries events through unvalidated", () => {
    // Each entry is the envelope parser's problem: validating here would
    // either duplicate that parser or let one malformed entry fail the batch.
    const result = parseOutboxPollResult({ events: [1, "two", null] });
    expect(result?.events).toEqual([1, "two", null]);
  });

  test.each([
    ["not an object", 42],
    ["an array", []],
    ["missing events", { cursor: "x" }],
    ["events not an array", { events: {} }],
    ["a non-string cursor", { events: [], cursor: 7 }],
    ["an empty cursor", { events: [], cursor: "" }],
    ["a non-boolean truncated", { events: [], truncated: "yes" }],
    ["a non-boolean hasMore", { events: [], hasMore: 1 }],
    ["a non-numeric nextPollMs", { events: [], nextPollMs: "soon" }],
    ["a non-positive nextPollMs", { events: [], nextPollMs: 0 }],
    ["an infinite nextPollMs", { events: [], nextPollMs: Number.POSITIVE_INFINITY }],
  ])("refuses %s", (_label, raw) => {
    expect(parseOutboxPollResult(raw)).toBeNull();
  });

  test("refuses an implausibly large batch", () => {
    expect(parseOutboxPollResult({ events: new Array(5_001).fill({}) })).toBeNull();
  });
});

describe("parseOutboxPollBody", () => {
  test("parses the JSON body", () => {
    expect(parseOutboxPollBody(JSON.stringify({ events: [] }))?.events).toEqual([]);
  });

  test("refuses a body that is not JSON, and one that is missing", () => {
    expect(parseOutboxPollBody("<html>nope</html>")).toBeNull();
    expect(parseOutboxPollBody(undefined)).toBeNull();
  });
});
