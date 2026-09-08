/**
 * The template subset a route's tool input is rendered through.
 *
 * Five names, no logic, and a count of everything it could not resolve. The
 * output goes into somebody's Slack channel, so what it does with an unknown
 * name matters as much as what it does with a known one.
 */

import { describe, expect, test } from "bun:test";
import { renderDeliverInput } from "../../../src/notifications/template.ts";
import type { NotificationPresentation } from "../../../src/notifications/types.ts";

const FULL: NotificationPresentation = {
  level: "attention",
  title: "acme-outreach.com is active",
  body: "The registrar confirmed it.",
  subject: "acme-outreach.com",
  link: { resource: "acme://domains/acme-outreach.com" },
};

const MINIMAL: NotificationPresentation = { level: "info", title: "domain.active" };

/** What the runtime contributes. Supplied by the dispatcher, never by a server. */
const HOST = { inboxUrl: "https://tenant.example/w/team/notifications?item=acme%3Aevt_1" };

/** Every case below renders against the same host block unless it says otherwise. */
function render(
  input: Record<string, unknown> | undefined,
  presentation: NotificationPresentation,
  host = HOST,
) {
  return renderDeliverInput(input, presentation, host);
}

describe("the five placeholders", () => {
  test("each resolves from the presentation block", () => {
    const { input, misses } = render(
      { text: "{{title}} | {{body}} | {{subject}} | {{link.resource}}" },
      FULL,
    );
    expect(input.text).toBe(
      "acme-outreach.com is active | The registrar confirmed it. | acme-outreach.com | " +
        "acme://domains/acme-outreach.com",
    );
    expect(misses).toBe(0);
  });

  test("whitespace inside the braces is allowed, as the validator's is", () => {
    expect(render({ text: "{{  title  }}" }, FULL).input.text).toBe(
      "acme-outreach.com is active",
    );
  });

  test("a known name with no value renders empty and is NOT a miss", () => {
    // The ordinary case: most items have no body and no link. Counting it
    // would make the metric a measure of how terse connectors are.
    const { input, misses } = render({ text: "[{{body}}][{{link.resource}}]" }, MINIMAL);
    expect(input.text).toBe("[][]");
    expect(misses).toBe(0);
  });

  test("one placeholder can appear many times", () => {
    const { input } = render({ text: "{{subject}}/{{subject}}" }, FULL);
    expect(input.text).toBe("acme-outreach.com/acme-outreach.com");
  });
});

describe("a placeholder outside the five", () => {
  test("renders empty and is counted", () => {
    const { input, misses } = render({ text: "a{{data.domain}}b" }, FULL);
    expect(input.text).toBe("ab");
    expect(misses).toBe(1);
  });

  test("`data` is not reachable under any spelling", () => {
    const { input, misses } = render({ text: "{{data}}{{data.x}}{{envelope}}" }, FULL);
    expect(input.text).toBe("");
    expect(misses).toBe(3);
  });

  test("is counted once per occurrence, not once per name", () => {
    expect(render({ text: "{{nope}} {{nope}}" }, FULL).misses).toBe(2);
  });
});

describe("what is rendered", () => {
  test("nested objects and arrays, all the way down", () => {
    const { input } = render(
      { blocks: [{ text: { content: "{{title}}" } }], channel: "#outbound" },
      FULL,
    );
    expect(input).toEqual({
      blocks: [{ text: { content: "acme-outreach.com is active" } }],
      channel: "#outbound",
    });
  });

  test("keys, because a placeholder used as one reaches the tool just as literally", () => {
    const { input } = render({ "{{subject}}": "x" }, FULL);
    expect(input).toEqual({ "acme-outreach.com": "x" });
  });

  test("nothing else — numbers, booleans and null pass through", () => {
    const { input } = render({ n: 3, b: true, z: null }, FULL);
    expect(input).toEqual({ n: 3, b: true, z: null });
  });

  test("an absent input is an empty object, not a missing argument", () => {
    expect(render(undefined, FULL)).toEqual({ input: {}, misses: 0 });
  });
});

describe("what it does not do", () => {
  test("no sections, no inversions — Mustache logic is text here", () => {
    const { input, misses } = render({ text: "{{#body}}x{{/body}}" }, FULL);
    // Both tags name something outside the five, so both render empty. What
    // matters is that neither is interpreted as control flow.
    expect(input.text).toBe("x");
    expect(misses).toBe(2);
  });

  test("no escaping — a value with markup or quotes survives intact", () => {
    const { input } = render({ text: "{{title}}" }, {
      level: "info",
      title: `it's <b>"live"</b> & well`,
    });
    expect(input.text).toBe(`it's <b>"live"</b> & well`);
  });

  test("a rendered value is not itself re-rendered", () => {
    // A connector that writes `{{title}}` into its own body cannot make the
    // runtime expand it: substitution is one pass over the template.
    const { input, misses } = render({ text: "{{body}}" }, {
      level: "info",
      title: "t",
      body: "{{title}}",
    });
    expect(input.text).toBe("{{title}}");
    expect(misses).toBe(0);
  });
});

describe("inbox.url — the one placeholder the host supplies", () => {
  test("resolves to the address the dispatcher built", () => {
    const { input, misses } = render({ text: "Open: {{inbox.url}}" }, MINIMAL);
    expect(input.text).toBe(
      "Open: https://tenant.example/w/team/notifications?item=acme%3Aevt_1",
    );
    expect(misses).toBe(0);
  });

  test("renders empty, and is NOT a miss, when the runtime could not build one", () => {
    // The dispatcher passes "" when `webOrigin()` throws on a malformed
    // configured origin. That is the same shape as an absent optional — a known
    // name with no value — so it must not be counted against the template.
    const { input, misses } = render({ text: "[{{inbox.url}}]" }, FULL, { inboxUrl: "" });
    expect(input.text).toBe("[]");
    expect(misses).toBe(0);
  });

  test("is independent of link.resource, which stays the server's own URI", () => {
    const { input } = render({ text: "{{link.resource}} vs {{inbox.url}}" }, FULL);
    expect(input.text).toBe(
      "acme://domains/acme-outreach.com vs " +
        "https://tenant.example/w/team/notifications?item=acme%3Aevt_1",
    );
  });
});
