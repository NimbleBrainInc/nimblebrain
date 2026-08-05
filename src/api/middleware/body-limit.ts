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
 * Largest refused body worth reading before answering.
 *
 * Draining costs the read, and on the JSON routes that read is work an
 * unauthenticated caller can ask for: `POST /v1/auth/refresh` carries neither
 * auth nor a rate limiter, and the only ceiling underneath is Bun's
 * `maxRequestBodySize` default of 128 MB — 128x the 1 MB those routes cap at.
 * Past this bound the refusal goes out immediately and the connection takes
 * the consequences, which is the better trade at that size.
 *
 * Sized to the bodies that actually overrun a configured limit rather than
 * the largest one Bun would hand us: the multipart and JSON overruns that
 * desynchronize the connection in practice are single-digit MB.
 */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;

/**
 * Read and discard the body of a request we are about to refuse, up to
 * `MAX_DRAIN_BYTES`. A larger declared body is left unread.
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
 * Discarding is streamed, so a refused body costs the read but never the
 * buffer this middleware exists to avoid.
 */
async function discardBody(request: Request, declaredLength: number): Promise<void> {
  if (declaredLength > MAX_DRAIN_BYTES) return;
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
 * oversized uploads before we buffer them. A refused body up to
 * `MAX_DRAIN_BYTES` is still read and discarded, never buffered, so the
 * connection survives the refusal.
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
      await discardBody(c.req.raw, received);
      return apiError(413, "payload_too_large", "Payload too large", {
        limit,
        received,
        contentType,
      });
    }
    await next();
  });
}
