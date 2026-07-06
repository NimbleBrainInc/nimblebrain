import { describe, expect, it } from "bun:test";
import { parseUrl } from "../src/components/LinkSafetyModal";

describe("parseUrl (link-safety modal)", () => {
  it("splits a full URL into domain, path, and initial", () => {
    const r = parseUrl("https://bytemarkscafe.org/2026/04/04/episode-919");
    expect(r.domain).toBe("bytemarkscafe.org");
    expect(r.rest).toBe("/2026/04/04/episode-919");
    expect(r.initial).toBe("B");
  });

  it("strips a leading www.", () => {
    const r = parseUrl("https://www.example.com/path");
    expect(r.domain).toBe("example.com");
    expect(r.rest).toBe("/path");
    expect(r.initial).toBe("E");
  });

  it("collapses a bare origin to an empty path", () => {
    expect(parseUrl("https://example.com").rest).toBe("");
    expect(parseUrl("https://example.com/").rest).toBe("");
  });

  it("keeps query and hash in the path", () => {
    expect(parseUrl("https://example.com/a?b=1#c").rest).toBe("/a?b=1#c");
  });

  it("falls back to the raw string when it is not a parseable URL", () => {
    const r = parseUrl("not a url");
    expect(r.domain).toBe("not a url");
    expect(r.rest).toBe("");
    expect(r.initial).toBe("N");
  });

  it("uses '?' as the initial when there is no leading character", () => {
    expect(parseUrl("").initial).toBe("?");
  });
});
