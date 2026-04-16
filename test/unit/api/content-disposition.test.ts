import { describe, test, expect } from "bun:test";
import { sanitizeFilename } from "../../../src/api/handlers.ts";

describe("sanitizeFilename", () => {
  test("sanitizes double quotes in filename", () => {
    expect(sanitizeFilename('report".pdf')).toBe("report_.pdf");
  });

  test("sanitizes newlines in filename", () => {
    expect(sanitizeFilename("file\r\nname.txt")).toBe("file__name.txt");
  });

  test("sanitizes null bytes", () => {
    expect(sanitizeFilename("file\x00name.txt")).toBe("file_name.txt");
  });

  test("passes normal filenames unchanged", () => {
    expect(sanitizeFilename("report-2026.pdf")).toBe("report-2026.pdf");
  });

  test("handles unicode filenames", () => {
    expect(sanitizeFilename("\u30EC\u30DD\u30FC\u30C8.pdf")).toBe(
      "\u30EC\u30DD\u30FC\u30C8.pdf",
    );
  });
});
