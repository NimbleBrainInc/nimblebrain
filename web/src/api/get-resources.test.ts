import { describe, expect, test } from "bun:test";
import { isTextMimeType, parseResourceResponse } from "./client";

describe("isTextMimeType", () => {
  test("classifies text/* as text", () => {
    expect(isTextMimeType("text/html")).toBe(true);
    expect(isTextMimeType("text/plain")).toBe(true);
    expect(isTextMimeType("text/csv")).toBe(true);
  });

  test("classifies JSON and XML as text", () => {
    expect(isTextMimeType("application/json")).toBe(true);
    expect(isTextMimeType("application/xml")).toBe(true);
    expect(isTextMimeType("application/ld+json")).toBe(true);
    expect(isTextMimeType("application/xhtml+xml")).toBe(true);
    expect(isTextMimeType("image/svg+xml")).toBe(true);
  });

  test("classifies binary types as non-text", () => {
    expect(isTextMimeType("application/pdf")).toBe(false);
    expect(isTextMimeType("application/octet-stream")).toBe(false);
    expect(isTextMimeType("image/png")).toBe(false);
    expect(isTextMimeType("image/jpeg")).toBe(false);
    expect(isTextMimeType("video/mp4")).toBe(false);
  });
});

describe("parseResourceResponse", () => {
  test("returns text branch for text/html", async () => {
    const r = await parseResourceResponse(
      new Response("<html>ok</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.mimeType).toBe("text/html");
      expect(r.body).toBe("<html>ok</html>");
    }
  });

  test("returns blob branch for application/pdf without decoding bytes", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe]); // non-UTF8 bytes
    const r = await parseResourceResponse(
      new Response(bytes, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    expect(r.kind).toBe("blob");
    if (r.kind === "blob") {
      expect(r.mimeType).toBe("application/pdf");
      expect(r.body.size).toBe(6);
      const buf = new Uint8Array(await r.body.arrayBuffer());
      expect(Array.from(buf)).toEqual([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe]);
    }
  });

  test("returns blob branch for image/png", async () => {
    const r = await parseResourceResponse(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    expect(r.kind).toBe("blob");
  });

  test("falls back to application/octet-stream when Content-Type header is absent", async () => {
    // Construct a Response without any body so there's no auto Content-Type
    const res = new Response(null, { status: 200 });
    res.headers.delete("Content-Type");
    const r = await parseResourceResponse(res);
    expect(r.kind).toBe("blob");
    if (r.kind === "blob") {
      expect(r.mimeType).toBe("application/octet-stream");
    }
  });
});
