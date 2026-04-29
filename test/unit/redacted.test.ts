import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { Redacted, isRedacted } from "../../src/tools/redacted.ts";

describe("Redacted", () => {
  test("reveal returns the underlying value", () => {
    const r = new Redacted("secret-value");
    expect(r.reveal()).toBe("secret-value");
  });

  test("toString returns [redacted]", () => {
    const r = new Redacted("secret-value");
    expect(r.toString()).toBe("[redacted]");
    expect(`${r}`).toBe("[redacted]");
  });

  test("JSON.stringify omits the underlying value", () => {
    const r = new Redacted("secret-value");
    expect(JSON.stringify(r)).toBe('"[redacted]"');
    expect(JSON.stringify({ token: r })).toBe('{"token":"[redacted]"}');
  });

  test("util.inspect omits the underlying value", () => {
    const r = new Redacted("secret-value");
    expect(inspect(r)).toBe("[redacted]");
    expect(inspect({ token: r })).toContain("[redacted]");
    expect(inspect({ token: r })).not.toContain("secret-value");
  });

  test("supports non-string values", () => {
    const obj = { access_token: "a", refresh_token: "b" };
    const r = new Redacted(obj);
    expect(r.reveal()).toBe(obj);
    expect(JSON.stringify(r)).toBe('"[redacted]"');
  });

  test("isRedacted type guard", () => {
    expect(isRedacted(new Redacted("x"))).toBe(true);
    expect(isRedacted("x")).toBe(false);
    expect(isRedacted(null)).toBe(false);
    expect(isRedacted({})).toBe(false);
  });
});
