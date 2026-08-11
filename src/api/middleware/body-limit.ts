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
 * How far above a route's own limit a refused body is still worth reading.
 *
 * The ceiling is `limit + this`, not a constant, because what draining costs
 * has to be judged against what the route already grants. A caller who stays
 * in budget can make the route read `limit` bytes whenever it likes, so
 * reading that many on a refusal buys no new exposure; only the overrun past
 * `limit` is work the route would not otherwise have done, and that is what
 * this bounds. A flat ceiling cannot express it — set low enough to protect
 * `POST /v1/auth/refresh` (no auth, no rate limiter, 1 MB cap) it sits under
 * every multipart limit, and multipart is where the desync bites hardest.
 *
 * Past the ceiling the refusal goes out immediately and the connection takes
 * the consequences, which is the better trade at that size.
 */
const MAX_DRAIN_OVERRUN_BYTES = 8 * 1024 * 1024;

/**
 * How long the drain may go without receiving a byte before the refusal goes
 * out regardless.
 *
 * A sender can simply stop: without a deadline a body that stalls mid-transfer
 * holds the 413 until Bun's `idleTimeout` (`server.ts`) closes the socket with
 * nothing written, and on `POST /v1/auth/refresh` — no auth, no rate limiter —
 * one byte is enough to arrange it.
 *
 * It measures a stall rather than total elapsed time because the ceiling now
 * scales with the route's limit: a 100 MB multipart refusal drains legitimately
 * for far longer than any fixed budget worth granting a stalled sender, and a
 * total budget would cancel the drains that need it most while still waiting
 * the full budget on a sender sending nothing. Progress is the thing being
 * asked about, so progress is what resets the clock.
 *
 * Expiry costs only the drain: the refusal is still sent, and the connection
 * is left exactly as it would have been without any draining, so the worst
 * case degrades to the fail-fast this middleware did before.
 */
const DRAIN_STALL_MS = 2_000;

/**
 * Read and discard the body of a request we are about to refuse, up to
 * `limit + MAX_DRAIN_OVERRUN_BYTES`, abandoning it after `DRAIN_STALL_MS`
 * without a byte. A larger declared body is left unread, and a stalled one is
 * abandoned rather than waited on.
 *
 * HTTP/1.1 has no way to say "I stopped reading mid-body", so answering
 * before the body has arrived leaves a keep-alive connection in a state the
 * next request on it may not survive: that request can come back as a bare
 * `400` carrying only `Connection: close` — a parser-level rejection, not
 * one of ours — or never be answered at all. The victim is whichever request
 * follows, which on a pooled connection is a *different* one than the request
 * that overran the limit.
 *
 * Draining removes it, on both shapes of route. Over 60 paired runs of
 * `body-limit-routes` the unconsumed JSON body failed 11 times and the drained
 * body none; on multipart above the ceiling the effect is far larger, at 26
 * hung follow-ups in 30 pairs against 0 once drained. The precise fault inside
 * the server was not isolated — a hand-driven socket replaying the same
 * exchange stays healthy either way — so treat the drain as the measured fix,
 * not as a description of the underlying bug.
 *
 * Discarding is streamed, so a refused body costs the read but never the
 * buffer this middleware exists to avoid.
 */
async function discardBody(request: Request, declaredLength: number, limit: number): Promise<void> {
  if (declaredLength > limit + MAX_DRAIN_OVERRUN_BYTES) return;
  const body = request.body;
  if (!body) return;
  let stall: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = body.getReader();
    // Cancelling settles a read that is already pending, so a sender that
    // stops sending cannot outlast the deadline.
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => void reader.cancel().catch(() => {}), DRAIN_STALL_MS);
    };
    armStall();
    while (!(await reader.read()).done) {
      // Only the socket needs draining; the bytes go nowhere. Arriving bytes
      // are the progress the stall deadline is watching for.
      armStall();
    }
  } catch {
    // Sender hung up, or the body was already claimed — there is nothing left
    // to drain, and refusing still has to happen either way.
  } finally {
    clearTimeout(stall);
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
 * oversized uploads before we buffer them. A refused body within
 * `MAX_DRAIN_OVERRUN_BYTES` of the applicable limit is still read and
 * discarded, never buffered, so the connection survives the refusal.
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
      await discardBody(c.req.raw, received, limit);
      return apiError(413, "payload_too_large", "Payload too large", {
        limit,
        received,
        contentType,
      });
    }
    await next();
  });
}
