import { describe, test, expect } from "bun:test";
import { extractText } from "../../../src/files/extract.ts";

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
    const result = await extractText(
      Buffer.from("not a real xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(result).toBeNull();
  });

  test("empty buffer for text type returns empty string", async () => {
    const result = await extractText(Buffer.from(""), "text/plain");
    expect(result).toEqual({ text: "", truncated: false });
  });
});
