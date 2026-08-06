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
 * Sized to the overruns measured on the JSON routes, which cap at 1 MB.
 * Multipart is not covered: those routes cap at `files.maxTotalSize`, 100 MB
 * by default, so a refusal there sits far above this ceiling and is answered
 * without draining. Covering it needs a ceiling derived from each route's own
 * limit, which is tracked separately.
 */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;

/**
 * How long the drain may run before the refusal goes out regardless.
 *
 * A sender can simply stop: without a deadline a body that stalls mid-transfer
 * holds the 413 until Bun's `idleTimeout` (`server.ts`) closes the socket with
 * nothing written, and on `POST /v1/auth/refresh` — no auth, no rate limiter —
 * one byte is enough to arrange it.
 *
 * Expiry costs only the drain: the refusal is still sent, and the connection
 * is left exactly as it would have been without any draining, so the worst
 * case degrades to the fail-fast this middleware did before. Generous against
 * the ~35ms an in-ceiling drain actually takes.
 */
const DRAIN_DEADLINE_MS = 2_000;

/**
 * Read and discard the body of a request we are about to refuse, up to
 * `MAX_DRAIN_BYTES` and `DRAIN_DEADLINE_MS`. A larger declared body is left
 * unread, and a stalled one is abandoned rather than waited on.
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
  let expiry: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = body.getReader();
    // Cancelling settles a read that is already pending, so a sender that
    // stops sending cannot outlast the deadline.
    expiry = setTimeout(() => void reader.cancel().catch(() => {}), DRAIN_DEADLINE_MS);
    while (!(await reader.read()).done) {
      // Only the socket needs draining; the bytes go nowhere.
    }
  } catch {
    // Sender hung up, or the body was already claimed — there is nothing left
    // to drain, and refusing still has to happen either way.
  } finally {
    clearTimeout(expiry);
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
