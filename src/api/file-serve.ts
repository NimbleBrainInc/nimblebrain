/**
 * The browser download door, `GET /v1/workspaces/:wsId/files/:fileId`
 * (`contracts/files/CONTRACT.md` §10.4): the file is resolved as `host` with
 * the caller's own workspace and owner, and its body streamed from the
 * download URL under the host's own headers. Nothing of the URL's answer passes
 * through but its length and, for a range, its `Content-Range`.
 */

import type { FilesHost, OwnerScope } from "../files/host.ts";
import { isAllowedType } from "../files/mime.ts";
import type { ByteRange } from "../files/transfer.ts";
import { fileIdToUri } from "../files/uri.ts";
import { log } from "../observability/log.ts";
import { DEFAULT_CSP } from "./middleware/security-headers.ts";
import { apiError } from "./types.ts";

/**
 * The policy stored bytes are served under, whatever the operator sets as `NB_CSP`. A stored file
 * is a person's or an agent's upload, served on the shell's origin, so an HTML or SVG file opened
 * directly must never run script there. `sandbox` gives the document an opaque origin with
 * scripts, forms and popups off; the rest is the platform's default policy. An image in an
 * `<img>` and a PDF in the browser's viewer render under it unchanged.
 */
export const FILE_BYTES_CSP = `sandbox; ${DEFAULT_CSP}`;

/**
 * A `Content-Disposition` for `filename` that no name can break or inject into:
 * an ASCII fallback with control characters, quotes, backslashes and path
 * separators replaced, and the name itself as RFC 6266 `filename*`.
 */
export function contentDisposition(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control byte in the name could split or inject the header, so matching them is the point
  const clean = filename.replace(/[\x00-\x1f\x7f"\\/]/g, "_").trim() || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The type a body is served under: the record's when it is on the allowlist, else octet-stream. */
export function servedType(mimeType: string): string {
  // The record's type crosses into a header only when it is a plain token pair.
  const plain = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType.trim());
  return plain && isAllowedType(mimeType) ? mimeType.trim() : "application/octet-stream";
}

/**
 * One `bytes=a-b`, `bytes=a-` or `bytes=-n` range of a `size`-byte body, or
 * null when the header asks for none this door honours (several ranges, another
 * unit), which is answered with the whole body; `"unsatisfiable"` for a range
 * past the end.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (size === 0) return "unsatisfiable";
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** Serve one file to the browser: found through `resolve`, streamed from its download URL. */
export async function serveFileDownload(
  host: FilesHost,
  scope: OwnerScope,
  fileId: string,
  rangeHeader: string | null,
): Promise<Response> {
  const [answer] = await host.resolve(scope, [fileIdToUri(fileId)]);
  if (!answer?.found) return apiError(404, "not_found", "File not found");
  const { file } = answer;
  const range = parseRange(rangeHeader, file.size);
  const headers: Record<string, string> = {
    "Content-Type": servedType(file.mimeType),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": FILE_BYTES_CSP,
    "Content-Disposition": contentDisposition(file.filename),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${file.size}` },
    });
  }
  try {
    const got = await host.transfer.download(answer.download.url, {
      size: file.size,
      ...(range ? { range } : {}),
    });
    return new Response(got.body, {
      status: got.status,
      headers: {
        ...headers,
        "Content-Length": String(got.length),
        ...(got.contentRange ? { "Content-Range": got.contentRange } : {}),
      },
    });
  } catch (err) {
    log.warn("[files] a download failed", {
      fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError(502, "file_unavailable", "The file could not be read");
  }
}
