import { describe, test, expect } from "bun:test";
import { isTextMime, resolveMimeType } from "../../../src/files/mime.ts";
import { isExtractable } from "../../../src/files/ingest.ts";

describe("resolveMimeType", () => {
  test("recovers text/plain for a .typ upload with no Content-Type", () => {
    // The browser leaves Content-Type empty for extensions it doesn't know
    // (Typst), which is the original bug: stored as opaque binary, unreadable.
    expect(resolveMimeType("engagement-plan.typ", "")).toBe("text/plain");
    expect(resolveMimeType("engagement-plan.typ", undefined)).toBe("text/plain");
  });

  test("recovers text/plain when the type is the generic octet-stream", () => {
    expect(resolveMimeType("plan.typ", "application/octet-stream")).toBe("text/plain");
    // Case/charset variants of the generic type still trigger recovery.
    expect(resolveMimeType("plan.typ", "APPLICATION/OCTET-STREAM")).toBe("text/plain");
    expect(resolveMimeType("plan.typ", "application/octet-stream; charset=binary")).toBe(
      "text/plain",
    );
  });

  test("maps structured formats to their registered text types", () => {
    expect(resolveMimeType("a.md", "")).toBe("text/markdown");
    expect(resolveMimeType("a.json", "application/octet-stream")).toBe("application/json");
    expect(resolveMimeType("a.yaml", "")).toBe("application/yaml");
    expect(resolveMimeType("a.csv", "")).toBe("text/csv");
    expect(resolveMimeType("a.html", "")).toBe("text/html");
  });

  test("every mapped type passes both read gates (no store-then-fail-to-read)", () => {
    // INVARIANT guard: anything the map produces must be readable everywhere.
    for (const ext of ["typ", "md", "json", "yaml", "xml", "html", "csv", "py", "toml", "ts"]) {
      const resolved = resolveMimeType(`file.${ext}`, "");
      expect(isTextMime(resolved)).toBe(true);
      expect(isExtractable(resolved)).toBe(true);
    }
  });

  test("trusts a specific client-supplied type as-is", () => {
    expect(resolveMimeType("photo.png", "image/png")).toBe("image/png");
    // A specific type wins even when the extension is in the map.
    expect(resolveMimeType("data.json", "text/markdown")).toBe("text/markdown");
    // Parameters are preserved (only surrounding whitespace trimmed).
    expect(resolveMimeType("a.md", "  text/markdown; charset=utf-8  ")).toBe(
      "text/markdown; charset=utf-8",
    );
  });

  test("keeps octet-stream for unknown or extension-less files", () => {
    // Real binary with an unmapped extension stays binary — not mislabeled.
    expect(resolveMimeType("archive.bin", "")).toBe("application/octet-stream");
    expect(resolveMimeType("photo.png", "application/octet-stream")).toBe(
      "application/octet-stream",
    );
    expect(resolveMimeType("README", "")).toBe("application/octet-stream");
    expect(resolveMimeType(undefined, "")).toBe("application/octet-stream");
  });

  test("extension match is case-insensitive", () => {
    expect(resolveMimeType("PLAN.TYP", "")).toBe("text/plain");
  });
});

describe("isExtractable text/* consistency", () => {
  test("admits any text/* subtype, matching isTextMime", () => {
    // The read gate must accept everything extractText can UTF-8 decode.
    expect(isExtractable("text/x-typst")).toBe(true);
    expect(isExtractable("text/plain")).toBe(true);
    expect(isExtractable("text/markdown; charset=utf-8")).toBe(true);
  });

  test("still rejects real binary types", () => {
    expect(isExtractable("application/octet-stream")).toBe(false);
    expect(isExtractable("image/png")).toBe(false);
  });
});
