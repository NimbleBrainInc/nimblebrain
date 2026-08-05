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
 * Read and discard the body of a request we are about to refuse.
 *
 * HTTP/1.1 has no way to say "I stopped reading mid-body", so answering
 * before the body has arrived leaves a keep-alive connection in a state the
 * next request on it may not survive: that request can come back as a bare
 * `400` carrying only `Connection: close` — a parser-level rejection, not
 * one of ours — or never be answered at all. The victim is whichever request
 * follows, which on a pooled connection is a *different* one than the request
 * that overran the limit.
 *
 * Draining removes it: over 60 paired runs of `body-limit-routes`, the
 * unconsumed body failed 11 times and the drained body none. The precise
 * fault inside the server was not isolated — a hand-driven socket replaying
 * the same exchange stays healthy either way — so treat the drain as the
 * measured fix, not as a description of the underlying bug.
 *
 * Discarding is streamed, so an oversized body still costs only the read and
 * never the buffer this middleware exists to avoid, and it is bounded by the
 * same server-level ceilings that bound an in-budget upload.
 */
async function discardBody(request: Request): Promise<void> {
  const body = request.body;
  if (!body) return;
  try {
    const reader = body.getReader();
    while (!(await reader.read()).done) {
      // Only the socket needs draining; the bytes go nowhere.
    }
  } catch {
    // Sender hung up or the stream errored — there is nothing left to drain
    // and the connection is being torn down regardless.
  }
}

/**
 * Request body size limit middleware.
 * Returns 413 Payload Too Large if Content-Length exceeds the applicable
 * limit. JSON payloads are bounded by `maxBytes`; multipart uploads use
 * `opts.multipart` when provided, otherwise they fall back to `maxBytes`.
 *
 * This is advisory: requests without `Content-Length` (e.g. chunked
 * transfer encoding) or with malformed headers pass through untouched.
 * The ingest pipeline in `src/files/ingest.ts` enforces per-file,
 * total-size, and MIME rules authoritatively — middleware only stops
 * oversized uploads before we buffer them.
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
      await discardBody(c.req.raw);
      return apiError(413, "payload_too_large", "Payload too large", {
        limit,
        received,
        contentType,
      });
    }
    await next();
  });
}
