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
 */
const DRAIN_STALL_MS = 2_000;

/**
 * Slowest sustained transfer the drain will wait out, used to derive a total
 * budget from the declared length.
 *
 * The stall window alone cannot bound the drain, because it asks the wrong
 * question. "Has the sender stopped?" is answered by one byte, so a sender
 * pacing itself just inside the window is never cancelled and picks the
 * duration the refusal is withheld — `declaredLength × gap`, which at a byte
 * every 1.9s runs to weeks. The middleware awaits the drain before answering,
 * and the read is the only thing on `POST /v1/auth/refresh` that touches the
 * body at all (`handleOidcRefresh` reads a cookie), so on the one route with
 * neither auth nor a rate limiter that hold is free to take.
 *
 * The byte ceiling does not transfer to time — bounding *what* is read says
 * nothing about *how long* it may take — so the two bounds are separate
 * questions and get separate answers. Deriving the budget from the declared
 * length rather than fixing it flat keeps the terms the byte ceiling already
 * set: a body the route agreed to read gets time to arrive in proportion to
 * its size, and a sender slower than this floor is no longer worth waiting on.
 *
 * Expiry costs only the drain: the refusal is still sent, and the connection
 * is left exactly as it would have been without any draining, so the worst
 * case degrades to the fail-fast this middleware did before.
 */
const DRAIN_FLOOR_BYTES_PER_SEC = 128 * 1024;

/**
 * Total wall-clock the drain may take, from the declared length at
 * `DRAIN_FLOOR_BYTES_PER_SEC`, floored at the stall window so a small body is
 * never granted less time than a stalled one.
 */
function drainBudgetMs(declaredLength: number): number {
  return Math.max(DRAIN_STALL_MS, (declaredLength / DRAIN_FLOOR_BYTES_PER_SEC) * 1_000);
}

/**
 * Read and discard the body of a request we are about to refuse, up to
 * `limit + MAX_DRAIN_OVERRUN_BYTES`, abandoning it after `DRAIN_STALL_MS`
 * without a byte or `drainBudgetMs` in total. A larger declared body is left
 * unread, and one that stalls or crawls is abandoned rather than waited on.
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
  let total: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = body.getReader();
    // Cancelling settles a read that is already pending, so a sender that
    // stops sending cannot outlast the deadline.
    const cancel = () => void reader.cancel().catch(() => {});
    // The two deadlines race, and whichever is reached first ends the drain.
    total = setTimeout(cancel, drainBudgetMs(declaredLength));
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(cancel, DRAIN_STALL_MS);
    };
    armStall();
    while (!(await reader.read()).done) {
      // Only the socket needs draining; the bytes go nowhere. Arriving bytes
      // are the progress the stall deadline is watching for — they reset that
      // one, never the total, which is what stops a paced sender from renewing
      // its own hold indefinitely.
      armStall();
    }
  } catch {
    // Sender hung up, or the body was already claimed — there is nothing left
    // to drain, and refusing still has to happen either way.
  } finally {
    clearTimeout(stall);
    clearTimeout(total);
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
