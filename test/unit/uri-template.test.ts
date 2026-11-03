import { describe, expect, it } from "bun:test";
import { expandsFrom, URI_TEMPLATE_MAX_URI_LENGTH } from "../../src/util/uri-template.ts";

describe("expandsFrom", () => {
  it("matches ordinary templates", () => {
    expect(expandsFrom("acme://contacts/{id}", "acme://contacts/c1")).toBe(true);
    expect(expandsFrom("acme://files/{+path}", "acme://files/a/b")).toBe(true);
    expect(expandsFrom("acme://items/{id}{?cursor}", "acme://items/i1?cursor=x")).toBe(true);
    expect(expandsFrom("acme://contacts/{id}", "acme://notes/n1")).toBe(false);
  });

  it("refuses a template with more than one boundary that can split", () => {
    expect(expandsFrom("acme://{kind}{id}{rev}", "acme://abc")).toBe(false);
    expect(expandsFrom("acme://{;a},{;b},{c}", "acme://a,b,c")).toBe(false);
  });

  it("refuses an unclosed or unparsable template", () => {
    expect(expandsFrom("acme://{id", "acme://x")).toBe(false);
    expect(expandsFrom("{".repeat(40_000), "x")).toBe(false);
  });

  it("matches no URI longer than the cap, so an allowed template stays cheap", () => {
    const at = `acme://files/${"a".repeat(URI_TEMPLATE_MAX_URI_LENGTH - "acme://files/".length)}`;
    expect(expandsFrom("acme://files/{+path}", at)).toBe(true);
    expect(expandsFrom("acme://files/{+path}", `${at}a`)).toBe(false);

    // One boundary that can split: quadratic in the URI's length, which the cap bounds.
    const started = performance.now();
    expect(expandsFrom("a{+p}b{q}c", `a${"b".repeat(URI_TEMPLATE_MAX_URI_LENGTH - 1)}`)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(50);
  });
});
