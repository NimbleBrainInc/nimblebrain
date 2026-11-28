import { describe, expect, test } from "bun:test";
import { contentDisposition, parseRange, servedType } from "../../../src/api/file-serve.ts";

describe("contentDisposition", () => {
  test("keeps an ordinary name, in both forms", () => {
    expect(contentDisposition("report-2026.pdf")).toBe(
      `inline; filename="report-2026.pdf"; filename*=UTF-8''report-2026.pdf`,
    );
  });

  test("replaces quotes, backslashes, path separators and control characters", () => {
    const header = contentDisposition('a"b\\c/d\r\ne\x00f.txt');
    expect(header).toStartWith(`inline; filename="a_b_c_d__e_f.txt"; filename*=`);
    for (const c of ["\r", "\n", "\u0000"]) expect(header).not.toContain(c);
  });

  test("a non-ASCII name falls back to ASCII and travels whole as filename*", () => {
    const header = contentDisposition("レポート.pdf");
    expect(header).toContain(`filename="____.pdf"`);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("レポート.pdf")}`);
  });

  test("an empty name is a placeholder", () => {
    expect(contentDisposition("")).toContain(`filename="file"`);
  });
});

describe("servedType", () => {
  test("an allowlisted type is served as recorded", () => {
    expect(servedType("image/png")).toBe("image/png");
  });

  test("an allowlisted type keeps its parameters: it is judged bare (CONTRACT.md §5)", () => {
    expect(servedType("text/plain;charset=utf-8")).toBe("text/plain;charset=utf-8");
    expect(servedType(" Text/Markdown; charset=UTF-8 ")).toBe("Text/Markdown; charset=UTF-8");
  });

  test("anything else is octet-stream, and so is a type that would break the header", () => {
    expect(servedType("text/javascript")).toBe("application/octet-stream");
    expect(servedType("text/javascript; charset=utf-8")).toBe("application/octet-stream");
    expect(servedType("text/plain\r\nSet-Cookie: x")).toBe("application/octet-stream");
    expect(servedType("text/plain; charset=utf-8\r\nSet-Cookie: x")).toBe(
      "application/octet-stream",
    );
    expect(servedType('text/plain; charset="utf-8"')).toBe("application/octet-stream");
    expect(servedType("text/plain; charset")).toBe("application/octet-stream");
  });
});

describe("parseRange", () => {
  test("one bytes range, open-ended and suffix forms", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=95-200", 100)).toEqual({ start: 95, end: 99 });
  });

  test("past the end is unsatisfiable; several ranges or another unit is the whole body", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange(null, 100)).toBeNull();
  });
});
