// ---------------------------------------------------------------------------
// artifact-kind — decide whether a resource_link is a "document artifact".
//
// A document artifact is long-form, readable content (a deep-research report,
// a generated markdown doc) that deserves its own reading surface — the chip
// + document panel — instead of the cramped inline box the chat stream gives
// every resource_link today. Binary resources (PDF, images, octet-stream)
// keep their inline preview via ResourceLinkView, which already picks the
// right HTML primitive per MIME and isolates the renderer process.
//
// Keyed off MIME, not the tool name, so it is the GENERAL artifact path:
// deep-research is just the first producer. Any future tool that emits a
// markdown/text resource_link gets the document surface for free.
// ---------------------------------------------------------------------------

/**
 * True when a resource_link should render as a document artifact (chip +
 * panel with rendered markdown) rather than an inline binary preview.
 *
 * `text/markdown` is the canonical case (deep-research reports). Plain text
 * is included so any tool emitting a long text doc gets the reading surface;
 * an unknown/absent MIME on a `files://`-style URI is treated as a document
 * too, since the inline `<pre>` fallback is exactly the cramped raw-text box
 * this feature replaces.
 */
export function isDocumentArtifact(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (mime === "text/markdown" || mime === "text/x-markdown") return true;
  if (mime === "text/plain") return true;
  return false;
}

/** True for MIME types we render as markdown (vs. monospaced plain text). */
export function isMarkdownMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  return mime === "text/markdown" || mime === "text/x-markdown";
}
