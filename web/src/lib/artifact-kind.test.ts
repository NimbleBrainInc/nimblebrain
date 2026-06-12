// ---------------------------------------------------------------------------
// artifact-kind — routing contract for resource_link document artifacts.
//
// The load-bearing case is the ALLOWLIST: a resource_link with NO declared
// MIME must NOT route to the document panel (which decodes blobs as text and
// would render binary bytes as garbage). It falls back to ResourceLinkView,
// which degrades to a download card. This pins that flip so it can't regress
// back to the old no-mime → document default.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { isDocumentArtifact, isMarkdownMime, normalizeMime } from "./artifact-kind";

describe("isDocumentArtifact", () => {
  test("a no-mime resource_link does NOT route to the document panel", () => {
    expect(isDocumentArtifact(undefined)).toBe(false);
    expect(isDocumentArtifact("")).toBe(false);
  });

  test("markdown and plain text route to the document panel", () => {
    expect(isDocumentArtifact("text/markdown")).toBe(true);
    expect(isDocumentArtifact("text/x-markdown")).toBe(true);
    expect(isDocumentArtifact("text/plain")).toBe(true);
  });

  test("tolerates parameters and casing on the MIME header", () => {
    expect(isDocumentArtifact("text/markdown; charset=utf-8")).toBe(true);
    expect(isDocumentArtifact("TEXT/PLAIN")).toBe(true);
    expect(isDocumentArtifact("  text/markdown  ")).toBe(true);
  });

  test("binary / unknown types fall back to the inline preview", () => {
    expect(isDocumentArtifact("application/pdf")).toBe(false);
    expect(isDocumentArtifact("application/octet-stream")).toBe(false);
    expect(isDocumentArtifact("image/png")).toBe(false);
    expect(isDocumentArtifact("text/html")).toBe(false);
  });
});

describe("isMarkdownMime", () => {
  test("markdown variants render as markdown; plain text does not", () => {
    expect(isMarkdownMime("text/markdown")).toBe(true);
    expect(isMarkdownMime("text/x-markdown; charset=utf-8")).toBe(true);
    expect(isMarkdownMime("text/plain")).toBe(false);
    expect(isMarkdownMime(undefined)).toBe(false);
  });
});

describe("normalizeMime", () => {
  test("strips parameters, trims, and lowercases; undefined for absent", () => {
    expect(normalizeMime("Text/Markdown; charset=UTF-8")).toBe("text/markdown");
    expect(normalizeMime("  text/plain ")).toBe("text/plain");
    expect(normalizeMime(undefined)).toBeUndefined();
    expect(normalizeMime("")).toBeUndefined();
  });
});
