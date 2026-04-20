import { createMiddleware } from "hono/factory";
import { apiError } from "../types.ts";

export interface BodyLimitOptions {
  /**
   * Optional override for `multipart/*` requests. When set, uploads using
   * `Content-Type: multipart/*` are bounded by this value rather than the
   * base JSON `maxBytes`. The ingest pipeline enforces per-file and total
   * caps authoritatively; this middleware only stops oversized requests
   * before we buffer them.
   */
  multipart?: number;
}

/**
 * Request body size limit middleware.
 * Returns 413 Payload Too Large if Content-Length exceeds the applicable
 * limit. JSON payloads are bounded by `maxBytes`; multipart uploads use
 * `opts.multipart` when provided, otherwise they fall back to `maxBytes`.
 */
export function bodyLimit(maxBytes: number, opts: BodyLimitOptions = {}) {
  return createMiddleware(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      return;
    }
    const contentLengthHeader = c.req.header("content-length");
    if (!contentLengthHeader) {
      await next();
      return;
    }
    const received = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isFinite(received) || received < 0) {
      await next();
      return;
    }
    const contentType = c.req.header("content-type") ?? "";
    const isMultipart = contentType.toLowerCase().startsWith("multipart/");
    const limit = isMultipart && opts.multipart !== undefined ? opts.multipart : maxBytes;
    if (received > limit) {
      return apiError(413, "payload_too_large", "Payload too large", {
        limit,
        received,
        contentType,
      });
    }
    await next();
  });
}
