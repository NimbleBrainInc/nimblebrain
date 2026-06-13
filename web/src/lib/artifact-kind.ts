// ---------------------------------------------------------------------------
// artifact-kind — decide whether a resource_link is a "document artifact".
//
// A document artifact is long-form, readable content (a deep-research report,
// a generated markdown doc) that deserves its own reading surface — the chip
// + document panel — instead of the cramped inline box the chat stream gives
// every resource_link today. Binary resources (PDF, images, octet-stream) and
// resources WITHOUT a declared MIME keep their inline preview via
// ResourceLinkView, which already picks the right HTML primitive per MIME,
// isolates the renderer process, and degrades to a download card.
//
// Keyed off MIME, not the tool name, so it is the GENERAL artifact path:
// deep-research is just the first producer. Any future tool that emits a
// markdown/text resource_link gets the document surface for free.
// ---------------------------------------------------------------------------

/**
 * Normalize a MIME header to its bare lowercased type: strips any `;`
 * parameters (charset etc.) and surrounding whitespace. Returns `undefined`
 * for an absent MIME so callers can branch on "no declared type".
 */
export function normalizeMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** True for MIME types we render as markdown (vs. monospaced plain text). */
export function isMarkdownMime(mimeType: string | undefined): boolean {
  const mime = normalizeMime(mimeType);
  return mime === "text/markdown" || mime === "text/x-markdown";
}

/**
 * True when a resource_link should render as a document artifact (chip +
 * panel with rendered markdown) rather than an inline binary preview.
 *
 * ALLOWLIST: only known long-form text types route to the document surface.
 * `text/markdown` is the canonical case (deep-research reports); plain text is
 * included so any tool emitting a long text doc gets the reading surface. An
 * unknown or ABSENT MIME falls back to ResourceLinkView, which handles text,
 * binary, and download-only resources gracefully — feeding a no-mime resource
 * into the document panel would decode binary bytes as garbage text.
 */
export function isDocumentArtifact(mimeType: string | undefined): boolean {
  const mime = normalizeMime(mimeType);
  if (!mime) return false;
  return isMarkdownMime(mime) || mime === "text/plain";
}
