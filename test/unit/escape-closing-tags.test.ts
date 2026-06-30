import { describe, expect, test } from "bun:test";
import { escapeClosingTags } from "../../src/conversation/escape-closing-tags.ts";

describe("escapeClosingTags", () => {
  test("neutralises a canonical closing tag", () => {
    expect(escapeClosingTags("a</conversation-summary>b")).toBe("a&lt;/conversation-summary>b");
  });

  test("neutralises whitespace-evasion forms the consumer (an LLM) would still honour", () => {
    // The old `replaceAll("</", "<\\/")` passed every one of these through.
    for (const close of [
      "</user-message>",
      "< /user-message>",
      "<\n/user-message>",
      "</ user-message>",
      "<  /user-message>",
      "</\nuser-message>",
    ]) {
      const out = escapeClosingTags(`x${close}y`);
      expect(out).toContain("&lt;/");
      // no literal `<` immediately preceding a `/` survives for a fuzzy parser
      expect(/<\s*\//.test(out)).toBe(false);
    }
  });

  test("escapes every occurrence, not just the first", () => {
    expect(escapeClosingTags("</a></b>")).toBe("&lt;/a>&lt;/b>");
  });

  test("leaves opening tags and bare text untouched", () => {
    expect(escapeClosingTags("<user-message>plain text 1 < 2")).toBe(
      "<user-message>plain text 1 < 2",
    );
  });

  test("is idempotent — a re-escaped body is unchanged", () => {
    const once = escapeClosingTags("</conversation-transcript>");
    expect(escapeClosingTags(once)).toBe(once);
  });
});
