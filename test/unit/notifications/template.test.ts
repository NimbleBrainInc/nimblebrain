/**
 * The template subset a route's tool input is rendered through.
 *
 * Four names, no logic, and a count of everything it could not resolve. The
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
  link: { resource: "po://domains/acme-outreach.com" },
};

const MINIMAL: NotificationPresentation = { level: "info", title: "domain.active" };

describe("the four placeholders", () => {
  test("each resolves from the presentation block", () => {
    const { input, misses } = renderDeliverInput(
      { text: "{{title}} | {{body}} | {{subject}} | {{link.resource}}" },
      FULL,
    );
    expect(input.text).toBe(
      "acme-outreach.com is active | The registrar confirmed it. | acme-outreach.com | " +
        "po://domains/acme-outreach.com",
    );
    expect(misses).toBe(0);
  });

  test("whitespace inside the braces is allowed, as the validator's is", () => {
    expect(renderDeliverInput({ text: "{{  title  }}" }, FULL).input.text).toBe(
      "acme-outreach.com is active",
    );
  });

  test("a known name with no value renders empty and is NOT a miss", () => {
    // The ordinary case: most items have no body and no link. Counting it
    // would make the metric a measure of how terse connectors are.
    const { input, misses } = renderDeliverInput({ text: "[{{body}}][{{link.resource}}]" }, MINIMAL);
    expect(input.text).toBe("[][]");
    expect(misses).toBe(0);
  });

  test("one placeholder can appear many times", () => {
    const { input } = renderDeliverInput({ text: "{{subject}}/{{subject}}" }, FULL);
    expect(input.text).toBe("acme-outreach.com/acme-outreach.com");
  });
});

describe("a placeholder outside the four", () => {
  test("renders empty and is counted", () => {
    const { input, misses } = renderDeliverInput({ text: "a{{data.domain}}b" }, FULL);
    expect(input.text).toBe("ab");
    expect(misses).toBe(1);
  });

  test("`data` is not reachable under any spelling", () => {
    const { input, misses } = renderDeliverInput({ text: "{{data}}{{data.x}}{{envelope}}" }, FULL);
    expect(input.text).toBe("");
    expect(misses).toBe(3);
  });

  test("is counted once per occurrence, not once per name", () => {
    expect(renderDeliverInput({ text: "{{nope}} {{nope}}" }, FULL).misses).toBe(2);
  });
});

describe("what is rendered", () => {
  test("nested objects and arrays, all the way down", () => {
    const { input } = renderDeliverInput(
      { blocks: [{ text: { content: "{{title}}" } }], channel: "#outbound" },
      FULL,
    );
    expect(input).toEqual({
      blocks: [{ text: { content: "acme-outreach.com is active" } }],
      channel: "#outbound",
    });
  });

  test("keys, because a placeholder used as one reaches the tool just as literally", () => {
    const { input } = renderDeliverInput({ "{{subject}}": "x" }, FULL);
    expect(input).toEqual({ "acme-outreach.com": "x" });
  });

  test("nothing else — numbers, booleans and null pass through", () => {
    const { input } = renderDeliverInput({ n: 3, b: true, z: null }, FULL);
    expect(input).toEqual({ n: 3, b: true, z: null });
  });

  test("an absent input is an empty object, not a missing argument", () => {
    expect(renderDeliverInput(undefined, FULL)).toEqual({ input: {}, misses: 0 });
  });
});

describe("what it does not do", () => {
  test("no sections, no inversions — Mustache logic is text here", () => {
    const { input, misses } = renderDeliverInput({ text: "{{#body}}x{{/body}}" }, FULL);
    // Both tags name something outside the four, so both render empty. What
    // matters is that neither is interpreted as control flow.
    expect(input.text).toBe("x");
    expect(misses).toBe(2);
  });

  test("no escaping — a value with markup or quotes survives intact", () => {
    const { input } = renderDeliverInput({ text: "{{title}}" }, {
      level: "info",
      title: `it's <b>"live"</b> & well`,
    });
    expect(input.text).toBe(`it's <b>"live"</b> & well`);
  });

  test("a rendered value is not itself re-rendered", () => {
    // A connector that writes `{{title}}` into its own body cannot make the
    // runtime expand it: substitution is one pass over the template.
    const { input, misses } = renderDeliverInput({ text: "{{body}}" }, {
      level: "info",
      title: "t",
      body: "{{title}}",
    });
    expect(input.text).toBe("{{title}}");
    expect(misses).toBe(0);
  });
});
