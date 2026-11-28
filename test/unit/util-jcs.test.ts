import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../src/util/jcs.ts";

describe("canonicalJson (RFC 8785)", () => {
  test("sorts members by UTF-16 code units, recursively, with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }] })).toBe(
      '{"a":[true,null,{"c":2,"d":"x"}],"b":1}',
    );
    // "€" (U+20AC) sorts before "😀" (U+1F600) by code unit.
    expect(canonicalJson({ "😀": 1, "€": 2 })).toBe('{"€":2,"😀":1}');
  });

  test("numbers and strings serialize as ECMAScript does", () => {
    expect(canonicalJson([1e21, 0.000001, -0, 4.5, "a\nb\u0001"])).toBe(
      '[1e+21,0.000001,0,4.5,"a\\nb\\u0001"]',
    );
  });

  test("a value JSON cannot hold throws", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
  });
});
