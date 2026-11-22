import { createMiddleware } from "hono/factory";
import { humanSize } from "../../files/human-size.ts";
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
  try {
    await drainReader(body.getReader(), declaredLength, drainBudgetMs(declaredLength));
  } catch {
    // The body was already claimed — there is nothing left to drain, and
    // refusing still has to happen either way.
  }
}

/** The two calls a drain makes on a body's reader. */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/** How a drain ended: the bytes it read, and whether it reached the body's end. */
interface DrainOutcome {
  read: number;
  complete: boolean;
}

/**
 * Read and discard what is left on `reader`, under the same deadlines as
 * {@link discardBody}: `DRAIN_STALL_MS` without a byte, `budgetMs` in total,
 * and no more than `maxBytes`. Whichever bound is reached first cancels the
 * read and ends the drain.
 */
async function drainReader(
  reader: ByteReader,
  maxBytes: number,
  budgetMs: number,
): Promise<DrainOutcome> {
  let read = 0;
  let complete = false;
  let cancelled = false;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  // Cancelling settles a read that is already pending, so a sender that
  // stops sending cannot outlast the deadline.
  const cancel = () => {
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  try {
    // The two deadlines race, and whichever is reached first ends the drain.
    total = setTimeout(cancel, budgetMs);
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(cancel, DRAIN_STALL_MS);
    };
    armStall();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      read += value?.byteLength ?? 0;
      if (read > maxBytes) {
        cancel();
        break;
      }
      // Only the socket needs draining; the bytes go nowhere. Arriving bytes
      // are the progress the stall deadline is watching for — they reset that
      // one, never the total, which is what stops a paced sender from renewing
      // its own hold indefinitely.
      armStall();
    }
  } catch {
    // Sender hung up — there is nothing left to drain.
  } finally {
    clearTimeout(stall);
    clearTimeout(total);
  }
  // A cancelled read reports `done`, so only a drain that was never cancelled
  // has seen the body's real end.
  return { read, complete: complete && !cancelled };
}

/** The result of reading a body that declared no length. */
type CountedBody =
  | { kind: "within"; bytes: Uint8Array }
  | { kind: "over"; received: number | undefined }
  | { kind: "unreadable" };

/**
 * Read a body that declared no `Content-Length` (chunked transfer encoding),
 * counting bytes as they arrive and stopping at `limit`.
 *
 * Within the limit, the bytes are returned so the route can be handed the same
 * body. Past it, the rest is drained on the same terms as a declared refusal,
 * so the connection survives; the total is reported only when the drain saw
 * the body's end. A body that cannot be read (the sender hung up) is reported
 * as such.
 */
async function readCountedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<CountedBody> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      read += value.byteLength;
      if (read > limit) {
        const ceiling = limit + MAX_DRAIN_OVERRUN_BYTES;
        const drained = await drainReader(reader, ceiling - read, drainBudgetMs(ceiling));
        return { kind: "over", received: drained.complete ? read + drained.read : undefined };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "within", bytes };
}

/**
 * The same request, carrying `bytes` as its body. The headers then describe
 * the body the route will read: its length, and no transfer encoding.
 */
function withBufferedBody(request: Request, bytes: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(bytes.byteLength));
  return new Request(request, { headers, body: bytes });
}

/**
 * The refusal's message, naming the size (when known) and the limit. The
 * message is what a client shows, so the limit belongs in it and not only in
 * `details`. A multipart body is an upload (a chat message's or the file
 * picker's), and its length counts the form encoding as well as the files.
 */
function payloadTooLargeMessage(
  received: number | undefined,
  limit: number,
  isMultipart: boolean,
): string {
  const noun = isMultipart ? "Upload" : "Request body";
  if (received === undefined) return `${noun} is over the limit of ${humanSize(limit)}.`;
  return `${noun} is ${humanSize(received)}; the limit is ${humanSize(limit)}.`;
}

/**
 * The size of the largest body the HTTP server will accept on any route:
 * `largestRouteLimit` plus the drain overrun.
 *
 * This is `Bun.serve`'s `maxRequestBodySize` (`server.ts`). Up to it, a body
 * over a route's limit reaches `bodyLimit` and gets the structured `413` and
 * the drain; past it, the server refuses the body itself with a bare `413`,
 * whatever the route and however the body is sent. It also bounds a route that
 * does not chain `bodyLimit`.
 */
export function serverBodyCeiling(largestRouteLimit: number): number {
  return largestRouteLimit + MAX_DRAIN_OVERRUN_BYTES;
}

/** What `bodyLimit` decides about a body: the request to hand on, or why not. */
type Admission =
  | { kind: "admit"; request: Request }
  | { kind: "over"; received: number | undefined }
  | { kind: "unreadable" };

/**
 * Judge a body against `limit`: by its declared `Content-Length` when it has a
 * valid one, otherwise by counting the bytes as they arrive. A counted body
 * within the limit is handed on as a request carrying the bytes read.
 */
async function admitBody(request: Request, limit: number): Promise<Admission> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared >= 0) {
    if (declared <= limit) return { kind: "admit", request };
    await discardBody(request, declared, limit);
    return { kind: "over", received: declared };
  }
  if (!request.body) return { kind: "admit", request };
  const counted = await readCountedBody(request.body, limit);
  if (counted.kind !== "within") return counted;
  return { kind: "admit", request: withBufferedBody(request, counted.bytes) };
}

/**
 * Request body size limit middleware: `413 payload_too_large` once a body is
 * over the applicable limit. JSON payloads are bounded by `maxBytes`; multipart
 * uploads use `opts.multipart` when provided, otherwise they fall back to
 * `maxBytes`.
 *
 * The limit holds on the bytes received, however the body is sent. A body
 * that declares `Content-Length` is judged by that length (the server reads no
 * more than it declares). A body without one (chunked transfer encoding), or
 * with a malformed one, is read here and counted: within the limit, the route
 * is handed the bytes read; past it, the request is refused once the limit is
 * crossed. The ingest pipeline in `src/files/ingest.ts` still enforces
 * per-file, total-size, and MIME rules for uploads. A refused body within
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
    const contentType = c.req.header("content-type") ?? "";
    const isMultipart = contentType.toLowerCase().startsWith("multipart/");
    const limit = isMultipart && opts.multipart !== undefined ? opts.multipart : maxBytes;
    const admission = await admitBody(c.req.raw, limit);
    if (admission.kind === "over") {
      const { received } = admission;
      return apiError(
        413,
        "payload_too_large",
        payloadTooLargeMessage(received, limit, isMultipart),
        { limit, ...(received === undefined ? {} : { received }), contentType },
      );
    }
    if (admission.kind === "unreadable") {
      return apiError(400, "bad_request", "The request body could not be read.");
    }
    c.req.raw = admission.request;
    await next();
  });
}
