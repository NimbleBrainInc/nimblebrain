import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { extractText } from "../../../src/files/extract.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// A 5x5 sheet committed at test/fixtures/files/spreadsheet-sample.xlsx, holding
// exactly the values the assertions below name. It is deliberately awkward: a
// cell containing the CSV delimiter, one containing quotes, one with an
// embedded newline, a non-ASCII string, an empty cell, a float, booleans, and
// real date-typed cells.
const spreadsheetFixture = () =>
  readFileSync(new URL("../../fixtures/files/spreadsheet-sample.xlsx", import.meta.url));

describe("extractText", () => {
  test("text/plain returns file content", async () => {
    const buf = Buffer.from("hello world");
    const result = await extractText(buf, "text/plain");
    expect(result).toEqual({ text: "hello world", truncated: false });
  });

  test("text/csv returns CSV content", async () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const result = await extractText(Buffer.from(csv), "text/csv");
    expect(result).toEqual({ text: csv, truncated: false });
  });

  test("application/json returns JSON string", async () => {
    const json = '{"key":"value"}';
    const result = await extractText(Buffer.from(json), "application/json");
    expect(result).toEqual({ text: json, truncated: false });
  });

  test("text/markdown returns markdown content", async () => {
    const md = "# Hello\n\nWorld";
    const result = await extractText(Buffer.from(md), "text/markdown");
    expect(result).toEqual({ text: md, truncated: false });
  });

  test("text/html returns HTML content", async () => {
    const html = "<h1>Hello</h1>";
    const result = await extractText(Buffer.from(html), "text/html");
    expect(result).toEqual({ text: html, truncated: false });
  });

  test("application/xml returns XML content", async () => {
    const xml = "<root><item>test</item></root>";
    const result = await extractText(Buffer.from(xml), "application/xml");
    expect(result).toEqual({ text: xml, truncated: false });
  });

  test("application/yaml returns YAML content", async () => {
    const yaml = "key: value\nlist:\n  - one\n  - two";
    const result = await extractText(Buffer.from(yaml), "application/yaml");
    expect(result).toEqual({ text: yaml, truncated: false });
  });

  test("large text file is truncated with notice", async () => {
    const maxSize = 200;
    const largeText = "x".repeat(300);
    const result = await extractText(Buffer.from(largeText), "text/plain", maxSize);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.text).toContain("[... truncated at 0 KB");
    expect(result!.text).toContain("use files__read for full content]");
    // The truncated text before the notice should be at most maxSize bytes
    const beforeNotice = result!.text.split("\n[... truncated")[0];
    expect(Buffer.byteLength(beforeNotice, "utf-8")).toBeLessThanOrEqual(maxSize);
  });

  test("custom truncation notice replaces files__read hint", async () => {
    const result = await extractText(Buffer.from("x".repeat(300)), "text/plain", 200, {
      truncatedSuffix: (kb) => `\n[... truncated at ${kb} KB]`,
    });

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.text).toContain("[... truncated at 0 KB]");
    expect(result!.text).not.toContain("files__read");
  });

  test("default maxSize truncates at 200KB", async () => {
    const size = 204_800 + 1000;
    const largeText = "a".repeat(size);
    const result = await extractText(Buffer.from(largeText), "text/plain");
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.text).toContain("[... truncated at 200 KB");
  });

  test("image/png returns null", async () => {
    const result = await extractText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(result).toBeNull();
  });

  test("image/jpeg returns null", async () => {
    const result = await extractText(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
    expect(result).toBeNull();
  });

  test("application/x-executable returns null", async () => {
    const result = await extractText(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "application/x-executable");
    expect(result).toBeNull();
  });

  test("unknown MIME type returns null", async () => {
    const result = await extractText(Buffer.from("data"), "application/octet-stream");
    expect(result).toBeNull();
  });

  test("any text/* subtype is decoded as UTF-8", async () => {
    // A .typ recovered to a text type extracts its source like any text file.
    const src = "#set page(width: 10cm)\n= Heading";
    const result = await extractText(Buffer.from(src), "text/x-typst");
    expect(result).toEqual({ text: src, truncated: false });
  });

  test("corrupted PDF returns null without throwing", async () => {
    const result = await extractText(Buffer.from("not a real pdf"), "application/pdf");
    expect(result).toBeNull();
  });

  test("corrupted DOCX returns null without throwing", async () => {
    const result = await extractText(
      Buffer.from("not a real docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result).toBeNull();
  });

  test("corrupted XLSX returns null without throwing", async () => {
    const result = await extractText(Buffer.from("not a real xlsx"), XLSX_MIME);
    expect(result).toBeNull();
  });

  // A PK-signature buffer that is not a readable workbook gets past the magic
  // byte guard and into the parser, so this is the case that proves the parser
  // itself is caught rather than throwing into the file-ingest path.
  test("XLSX with valid zip signature but unreadable body returns null", async () => {
    const result = await extractText(Buffer.from("PK still not a workbook"), XLSX_MIME);
    expect(result).toBeNull();
  });

  // Asserted as one string rather than per line: the "Multi" row holds a cell
  // with an embedded newline, so a line-split would tear that record in two and
  // an assertion built on it would encode the wrong shape.
  test("XLSX extracts the first sheet as CSV", async () => {
    const result = await extractText(spreadsheetFixture(), XLSX_MIME);
    expect(result).not.toBeNull();
    expect(result?.truncated).toBe(false);
    expect(result?.text).toBe(
      [
        "Region,Units,Note,Opened,Active",
        'West,12,"red, small",2026-01-15,true',
        'East,7,"has ""quotes""",2026-06-01,false',
        "Ünicode ✓,0,,2025-12-31,true",
        'Multi,3.5,"line\nbreak",2026-07-04,false',
      ].join("\n"),
    );
  });

  test("XLSX quotes only the fields that need it", async () => {
    const text = (await extractText(spreadsheetFixture(), XLSX_MIME))?.text ?? "";
    // Delimiter, embedded quote, and newline force quoting; plain values must not.
    expect(text).toContain('"red, small"');
    expect(text).toContain('"has ""quotes"""');
    expect(text).toContain("West,12,");
    expect(text).not.toContain('"West"');
  });

  test("XLSX renders dates as unambiguous ISO-8601, not locale-formatted", async () => {
    const text = (await extractText(spreadsheetFixture(), XLSX_MIME))?.text ?? "";
    expect(text).toContain("2026-01-15");
    // Excel's own display form for that cell — ambiguous without a locale.
    expect(text).not.toContain("1/15/26");
  });

  test("XLSX respects maxSize and marks the result truncated", async () => {
    const result = await extractText(spreadsheetFixture(), XLSX_MIME, 20);
    expect(result?.truncated).toBe(true);
    expect(result?.text.startsWith("Region,Units")).toBe(true);
  });

  test("empty buffer for text type returns empty string", async () => {
    const result = await extractText(Buffer.from(""), "text/plain");
    expect(result).toEqual({ text: "", truncated: false });
  });
});
