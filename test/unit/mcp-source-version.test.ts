import { describe, expect, it } from "bun:test";
import { sanitizeReportedVersion } from "../../src/tools/mcp-source.ts";

/**
 * `sanitizeReportedVersion` is the trust boundary for the connector-version
 * display: `serverInfo.version` comes from an untrusted MCP server (a Composio
 * gateway, a third-party OAuth server), so it is neutralized before the runtime
 * stores or the UI renders it. Pure function — test the boundary directly.
 *
 * Control / non-ASCII inputs are built with `String.fromCharCode` so this source
 * file stays pure ASCII (no raw control bytes, no high bytes).
 */
const ch = (code: number) => String.fromCharCode(code);

describe("sanitizeReportedVersion", () => {
  it("passes a normal version through untouched", () => {
    expect(sanitizeReportedVersion("0.2.0")).toBe("0.2.0");
    expect(sanitizeReportedVersion("1.4.2+build.7")).toBe("1.4.2+build.7");
    expect(sanitizeReportedVersion("a1b2c3d")).toBe("a1b2c3d");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeReportedVersion("  0.2.0  ")).toBe("0.2.0");
  });

  it("strips C0/C1 control characters (newline, tab, DEL, APC)", () => {
    expect(sanitizeReportedVersion(`0.2${ch(0x0a)}.0`)).toBe("0.2.0"); // newline
    expect(sanitizeReportedVersion(`${ch(0x09)}1.0`)).toBe("1.0"); // tab
    expect(sanitizeReportedVersion(`1.0${ch(0x7f)}${ch(0x9f)}`)).toBe("1.0"); // DEL + APC
  });

  it("caps length at 64 characters", () => {
    expect(sanitizeReportedVersion("9".repeat(200))).toBe("9".repeat(64));
  });

  it("caps by code points, never splitting a surrogate pair at the boundary", () => {
    // U+1F600 is one code point / two UTF-16 units. Placed so the naive
    // string.slice(0, 64) boundary would fall mid-pair (after 63 ASCII chars).
    const astral = String.fromCodePoint(0x1f600);
    const out = sanitizeReportedVersion(`${"a".repeat(63)}${astral}xx`);
    expect(out).toBe(`${"a".repeat(63)}${astral}`);
    expect(Array.from(out ?? "")).toHaveLength(64);
  });

  it("returns undefined when nothing usable remains", () => {
    expect(sanitizeReportedVersion("")).toBeUndefined();
    expect(sanitizeReportedVersion("   ")).toBeUndefined();
    expect(sanitizeReportedVersion(`${ch(0x00)}${ch(0x1f)}`)).toBeUndefined();
  });

  it("preserves printable non-ASCII (>= U+00A0)", () => {
    const v = `2.0-${ch(0xe9)}`; // 0xE9 = a printable Latin-1 letter
    expect(sanitizeReportedVersion(v)).toBe(v);
  });
});
