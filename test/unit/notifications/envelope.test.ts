/**
 * The envelope parser is the boundary between a connector's outbox and the
 * kernel's inbox, so everything it admits has to be re-derived from `unknown`.
 *
 * Two properties are pinned here and they are the whole contract:
 *
 *   - A known field with a malformed value drops the ENVELOPE, and the parser
 *     never throws. One bad event costs one event, never the poll.
 *   - An unknown key is preserved and ignored, so a server ahead of this host
 *     is not punished for being ahead — and `link.tool` / `actions[]`, absent
 *     from v1 by decision, are dropped rather than honored.
 */

import { describe, expect, test } from "bun:test";
import {
  NOTIFICATION_ENVELOPE_MAX_BYTES,
  parseNotificationEnvelope,
} from "../../../src/notifications/envelope.ts";
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_META_KEY,
  NOTIFICATION_TITLE_MAX,
  notificationPresentation,
} from "../../../src/notifications/types.ts";

/** A minimal well-formed `EventOccurrence`, with `overrides` merged over it. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt_01",
    name: "domain.active",
    timestamp: "2026-09-01T18:42:10Z",
    data: { provider: "acme" },
    ...overrides,
  };
}

/** The presentation block, with `overrides` merged over a valid one. */
function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _meta: {
      [NOTIFICATION_META_KEY]: {
        level: "attention",
        title: "acme-outreach.test is active",
        ...overrides,
      },
    },
  };
}

describe("a well-formed envelope", () => {
  test("keeps the four standard fields and normalizes the timestamp", () => {
    const parsed = parseNotificationEnvelope(envelope());
    expect(parsed).not.toBeNull();
    expect(parsed?.eventId).toBe("evt_01");
    expect(parsed?.name).toBe("domain.active");
    expect(parsed?.timestamp).toBe("2026-09-01T18:42:10.000Z");
    expect(parsed?.data).toEqual({ provider: "acme" });
  });

  test("with no _meta block is still a notification, defaulted from `name`", () => {
    const parsed = parseNotificationEnvelope(envelope());
    const presentation = notificationPresentation(parsed!);
    expect(presentation.level).toBe("info");
    expect(presentation.title).toBe("domain.active");
    expect(presentation.body).toBeUndefined();
  });

  test("carries the declared presentation through", () => {
    const parsed = parseNotificationEnvelope(
      envelope(meta({ subject: "acme-outreach.test", body: "DNS propagated." })),
    );
    const presentation = notificationPresentation(parsed!);
    expect(presentation).toEqual({
      level: "attention",
      title: "acme-outreach.test is active",
      subject: "acme-outreach.test",
      body: "DNS propagated.",
    });
  });

  test("keeps an optional cursor", () => {
    expect(parseNotificationEnvelope(envelope({ cursor: "c_17" }))?.cursor).toBe("c_17");
  });
});

describe("a malformed field drops the envelope", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing eventId", envelope({ eventId: undefined })],
    ["non-string eventId", envelope({ eventId: 7 })],
    ["empty eventId", envelope({ eventId: "" })],
    ["eventId with a control character", envelope({ eventId: "evt\u0007" })],
    ["missing name", envelope({ name: undefined })],
    ["name with whitespace", envelope({ name: "domain active" })],
    ["missing timestamp", envelope({ timestamp: undefined })],
    ["unparseable timestamp", envelope({ timestamp: "not-a-date" })],
    ["missing data", envelope({ data: undefined })],
    ["array data", envelope({ data: [1, 2] })],
    ["scalar data", envelope({ data: "opaque" })],
    ["non-string cursor", envelope({ cursor: 12 })],
    ["array _meta", envelope({ _meta: [] })],
    ["invented level", envelope(meta({ level: "critical" }))],
    ["non-string level", envelope(meta({ level: 2 }))],
    ["non-string title", envelope(meta({ title: { text: "hi" } }))],
    ["non-string body", envelope(meta({ body: 42 }))],
    ["non-string subject", envelope(meta({ subject: ["a"] }))],
    ["non-object link", envelope(meta({ link: "acme://x" }))],
    ["link.resource with no scheme", envelope(meta({ link: { resource: "/campaigns/1" } }))],
    [
      "link.resource with an executable scheme",
      envelope(meta({ link: { resource: "javascript:alert(1)" } })),
    ],
  ];

  for (const [label, input] of cases) {
    test(label, () => {
      expect(parseNotificationEnvelope(input)).toBeNull();
    });
  }

  test("never throws, whatever it is handed", () => {
    for (const input of [null, undefined, 7, "text", [], () => {}, new Date()]) {
      expect(() => parseNotificationEnvelope(input)).not.toThrow();
      expect(parseNotificationEnvelope(input)).toBeNull();
    }
  });

  test("an envelope over the size cap is refused", () => {
    const oversized = envelope({ data: { blob: "x".repeat(NOTIFICATION_ENVELOPE_MAX_BYTES) } });
    expect(parseNotificationEnvelope(oversized)).toBeNull();
  });
});

describe("unknown keys are preserved and ignored", () => {
  test("another vendor's _meta key survives", () => {
    const parsed = parseNotificationEnvelope(
      envelope({ _meta: { "com.example/trace": { id: "t1" } } }),
    );
    expect(parsed?._meta?.["com.example/trace"]).toEqual({ id: "t1" });
  });

  test("a field the block does not define is dropped, not honored", () => {
    const parsed = parseNotificationEnvelope(envelope(meta({ actions: [{ tool: "wire_money" }] })));
    const block = parsed?._meta?.[NOTIFICATION_META_KEY] as Record<string, unknown>;
    expect(block).toBeDefined();
    expect(block.actions).toBeUndefined();
  });

  test("link.tool is dropped while link.resource survives", () => {
    const parsed = parseNotificationEnvelope(
      envelope(meta({ link: { resource: "acme://campaigns/1", tool: "wire_money" } })),
    );
    expect(notificationPresentation(parsed!).link).toEqual({ resource: "acme://campaigns/1" });
  });
});

describe("title and body are plain text", () => {
  test("control characters are stripped rather than escaped", () => {
    const parsed = parseNotificationEnvelope(
      envelope(meta({ title: "one\nline\u001b[31m two", body: "a\tb" })),
    );
    const presentation = notificationPresentation(parsed!);
    expect(presentation.title).toBe("one line [31m two");
    expect(presentation.body).toBe("a b");
  });

  test("long text is capped", () => {
    const parsed = parseNotificationEnvelope(
      envelope(meta({ title: "t".repeat(500), body: "b".repeat(5000) })),
    );
    const presentation = notificationPresentation(parsed!);
    expect(presentation.title.length).toBe(NOTIFICATION_TITLE_MAX);
    expect(presentation.body?.length).toBe(NOTIFICATION_BODY_MAX);
  });

  test("a title that sanitizes to nothing falls back to the event name", () => {
    const parsed = parseNotificationEnvelope(envelope(meta({ title: "\u0000\u0001" })));
    expect(notificationPresentation(parsed!).title).toBe("domain.active");
  });
});
