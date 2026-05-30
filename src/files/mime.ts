/**
 * Text/blob mime classification shared between the agent-side
 * `files__read` tool and the bundle-side host-resources resolver.
 *
 * Single source of truth — if one path supports a new text-extractable
 * mime (e.g. `application/jsonl`), both pick it up automatically. Prior
 * to this extraction, the two paths duplicated the predicate verbatim
 * with a "keep in sync" comment, which is the failure mode this module
 * exists to prevent.
 */

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
 * Returns true when the mime should be delivered as `text` in MCP
 * resource contents; false to deliver as `blob` (base64).
 *
 * Conservative bias: `text/*` always returns true, plus an allowlist
 * of structured text formats under `application/*` whose bytes are
 * valid UTF-8 by spec.
 */
export function isTextMime(mimeType: string): boolean {
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return bare.startsWith("text/") || TEXT_MIMES.has(bare);
}

const GENERIC_BINARY = "application/octet-stream";

/**
 * Extension → MIME map, consulted only when the upload carries no usable
 * Content-Type. Browsers populate a file part's Content-Type from a built-in
 * extension table and leave it empty (which the upload handlers coerce to
 * `application/octet-stream`) for anything they don't recognise — Typst
 * (`.typ`) and most source/config formats. Without recovery those files are
 * stored as opaque binary and every text path (extraction, `isTextMime`
 * delivery, `files__read`) treats them as un-readable.
 *
 * INVARIANT — text/source extensions only. Every value here MUST be `text/*`
 * or one of the structured `application/*` types already in `TEXT_MIMES`
 * (`application/json`, `application/xml`, `application/yaml`). Two reasons:
 *   1. Those are the only values both `isTextMime` AND `isExtractable`
 *      (`ingest.ts`) accept, so anything else would store, then fail to read.
 *   2. The map is only ever applied to override a generic/empty type, so
 *      adding a binary-capable extension (`.doc`, `.png`, `.zip`) here would
 *      mislabel real binary as text and corrupt it on UTF-8 decode.
 * Source/code/config formats with no registered text subtype map to
 * `text/plain` — they are plain UTF-8 and `text/plain` is accepted everywhere.
 */
const EXTENSION_MIME: Record<string, string> = {
  // Structured text formats with a registered type in the allowlists.
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jsonl: "text/plain",
  ndjson: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  // Typst.
  typ: "text/plain",
  // Source / config / markup — plain UTF-8 with no registered text subtype.
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  cc: "text/plain",
  hpp: "text/plain",
  cs: "text/plain",
  php: "text/plain",
  swift: "text/plain",
  kt: "text/plain",
  scala: "text/plain",
  sh: "text/plain",
  bash: "text/plain",
  zsh: "text/plain",
  sql: "text/plain",
  js: "text/plain",
  mjs: "text/plain",
  cjs: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  css: "text/plain",
  scss: "text/plain",
  sass: "text/plain",
  less: "text/plain",
  toml: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  properties: "text/plain",
  tex: "text/plain",
  rst: "text/plain",
  adoc: "text/plain",
  org: "text/plain",
};

/** Lowercased extension without the dot, or "" when there isn't one. */
function fileExtension(filename: string | undefined): string {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Resolve a file's MIME type at ingest time.
 *
 * A specific client-supplied Content-Type is trusted as-is. When it is
 * missing or the generic `application/octet-stream`, the type is re-derived
 * from the filename extension so text source files the browser doesn't
 * recognise (e.g. `.typ`) are stored as text rather than opaque binary.
 * An unknown extension keeps `application/octet-stream` — real binary stays
 * binary. This is the single recovery point for every mint site (chat upload,
 * resource upload, `files__create`).
 */
export function resolveMimeType(filename: string | undefined, providedType?: string): string {
  const bare = (providedType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (bare && bare !== GENERIC_BINARY) {
    return providedType!.trim();
  }
  return EXTENSION_MIME[fileExtension(filename)] ?? GENERIC_BINARY;
}
