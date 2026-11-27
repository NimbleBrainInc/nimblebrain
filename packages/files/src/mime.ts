/**
 * Types, as the contract states them (CONTRACT.md §5 "Types", §7 "The allowlist"): a type's
 * bare form, the type a file records, the allowlist, a file's kind, and which types hold
 * text. `test/unit/contracts/contract-documents.test.ts` holds the extension table and the
 * kind table here to the tables in `contracts/files/CONTRACT.md`.
 */

/** A type with its parameters (`;charset=…`) stripped, surrounding space trimmed, case-folded. */
export function bareType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const GENERIC_BINARY = "application/octet-stream";

/**
 * The type a generic or empty `mimeType` records for a known extension. Every value is a
 * text type, so the map only ever turns opaque binary into readable text, never the
 * reverse.
 */
export const EXTENSION_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  ...Object.fromEntries(
    [
      "txt",
      "text",
      "log",
      "jsonl",
      "ndjson",
      "typ",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "c",
      "h",
      "cpp",
      "cc",
      "hpp",
      "cs",
      "php",
      "swift",
      "kt",
      "scala",
      "sh",
      "bash",
      "zsh",
      "sql",
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "css",
      "scss",
      "sass",
      "less",
      "toml",
      "ini",
      "cfg",
      "conf",
      "env",
      "properties",
      "tex",
      "rst",
      "adoc",
      "org",
    ].map((ext) => [ext, "text/plain"]),
  ),
};

/** The text after a filename's last `.`, case-folded; "" when it has no `.` or ends in one. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * The type a file records: `mimeType` as given (trimmed) when its bare type is neither empty
 * nor `application/octet-stream`; otherwise the extension's type, or
 * `application/octet-stream`.
 */
export function recordedType(filename: string, mimeType: string | undefined): string {
  const bare = bareType(mimeType ?? "");
  if (bare && bare !== GENERIC_BINARY) return (mimeType ?? "").trim();
  return EXTENSION_MIME[extensionOf(filename)] ?? GENERIC_BINARY;
}

export type FileKind = "image" | "document" | "data" | "font" | "other";

/** Each allowlisted type's kind. The allowlist is exactly this table's keys. */
const KIND_OF: Record<string, FileKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/svg+xml": "image",
  "font/ttf": "font",
  "font/otf": "font",
  "font/woff": "font",
  "font/woff2": "font",
  "text/csv": "data",
  "application/json": "data",
  "application/yaml": "data",
  "application/xml": "data",
  "text/xml": "data",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "data",
  "application/pdf": "document",
  "text/plain": "document",
  "text/markdown": "document",
  "text/html": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "text/yaml": "other",
  "application/zip": "other",
  "application/gzip": "other",
  "application/octet-stream": "other",
};

/** The types a file may have (CONTRACT.md §7). */
export const ALLOWED_TYPES: readonly string[] = Object.keys(KIND_OF);

export function isAllowed(mimeType: string): boolean {
  return Object.hasOwn(KIND_OF, bareType(mimeType));
}

/** A file's kind, from its bare type; a type off the allowlist is `other`. */
export function fileKind(mimeType: string): FileKind {
  return KIND_OF[bareType(mimeType)] ?? "other";
}

export const PDF = "application/pdf";
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const TEXT_APPLICATION_TYPES = new Set(["application/json", "application/xml", "application/yaml"]);

/** Whether the body is UTF-8 text as it stands: every `text/*` type, JSON, XML and YAML. */
export function isPlainText(mimeType: string): boolean {
  const bare = bareType(mimeType);
  return bare.startsWith("text/") || TEXT_APPLICATION_TYPES.has(bare);
}

/** Whether the type holds text the plugin extracts (CONTRACT.md §8). */
export function hasText(mimeType: string): boolean {
  const bare = bareType(mimeType);
  return isPlainText(bare) || bare === PDF || bare === DOCX || bare === XLSX;
}
