/**
 * What the host itself decides about a file's type: whether its type is on the
 * files contract's allowlist (`contracts/files/CONTRACT.md` §7), which the
 * intake checks before it opens any upload, and whether a body is text, which
 * the doors that answer `resources/read` use to send `text` or `blob`.
 *
 * Every other type rule (the type a file records, its kind, which types hold
 * extractable text) is the implementation's.
 */

/** A type with its parameters (`;charset=…`) stripped, surrounding space trimmed, case-folded. */
export function bareType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** The files contract 1.0's allowlist, compared as {@link bareType} (CONTRACT.md §7). */
export const FILE_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/zip",
  "application/gzip",
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/octet-stream",
]);

/** Whether `mimeType` is on the allowlist. */
export function isAllowedType(mimeType: string): boolean {
  return FILE_TYPE_ALLOWLIST.has(bareType(mimeType));
}

/** The type the host sends for a body whose sender named none. */
export const GENERIC_BINARY = "application/octet-stream";

const TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

/**
 * Whether a body of this type is delivered as `text` in MCP resource contents
 * (`false`: as a base64 `blob`). Every `text/*` type, plus the structured types
 * under `application/*` whose bytes are UTF-8 by their specification.
 */
export function isTextMime(mimeType: string): boolean {
  const bare = bareType(mimeType);
  return bare.startsWith("text/") || TEXT_MIMES.has(bare);
}

/** Raster images a model takes as input. SVG is read as text instead. */
export const REHYDRATABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Every image type on the allowlist. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  ...REHYDRATABLE_IMAGE_TYPES,
  "image/svg+xml",
]);

export const PDF_TYPE = "application/pdf";
