import type { FetchLike } from "@modelcontextprotocol/client";

/**
 * The most a remote connector may send in one answer. A host budget, not a
 * protocol limit. Base64 adds a third, so one answer carries a file of up to
 * about 48 MiB.
 */
export const MAX_REMOTE_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * A remote connector's answer outgrew the host budget. The answer itself is the
 * problem, so a restart or a retry would only fetch it again.
 */
export class RemoteResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Remote MCP response exceeds the host limit of ${maxBytes} bytes`);
    this.name = "RemoteResponseTooLargeError";
  }
}

const LF = 10;
const CR = 13;

/**
 * Counts one SSE stream. The budget is per event: it restarts only at the blank
 * line that ends an event (LF, CR or CRLF line endings), so a long-lived
 * stream of small events passes and one oversized event does not. A chunk is
 * scanned with `indexOf` from one line break to the next, so its cost follows
 * the number of line breaks, not the number of bytes.
 */
function sseCounter(maxBytes: number): (chunk: Uint8Array) => void {
  let eventBytes = 0;
  let lineBytes = 0;
  let afterCr = false;
  const count = (bytes: number) => {
    eventBytes += bytes;
    if (eventBytes > maxBytes) throw new RemoteResponseTooLargeError(maxBytes);
  };
  // A run of bytes with no line break in it.
  const text = (bytes: number) => {
    if (bytes === 0) return;
    count(bytes);
    lineBytes += bytes;
    afterCr = false;
  };
  const lineBreak = (isLf: boolean) => {
    count(1);
    // The LF of a CRLF belongs to the line its CR already ended.
    const crlf = afterCr && isLf;
    afterCr = !isLf;
    if (crlf) return;
    if (lineBytes === 0) eventBytes = 0;
    lineBytes = 0;
  };
  return (chunk) => {
    // The next LF and CR at or after `at`, each found again only once passed.
    let lf = -1;
    let cr = -1;
    for (let at = 0; at < chunk.length; ) {
      if (lf < at) lf = indexOrEnd(chunk, LF, at);
      if (cr < at) cr = indexOrEnd(chunk, CR, at);
      const brk = Math.min(lf, cr);
      text(brk - at);
      if (brk === chunk.length) return;
      lineBreak(brk === lf);
      at = brk + 1;
    }
  };
}

function indexOrEnd(chunk: Uint8Array, byte: number, from: number): number {
  const at = chunk.indexOf(byte, from);
  return at === -1 ? chunk.length : at;
}

/** Counts one whole body: a JSON answer, an error page, anything not a stream of events. */
function bodyCounter(maxBytes: number): (chunk: Uint8Array) => void {
  let bytes = 0;
  return (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new RemoteResponseTooLargeError(maxBytes);
  };
}

/** The JSON-RPC request ids a POST body carries, or none when it is not one. */
function requestIds(init: RequestInit | undefined): (string | number)[] {
  if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return [];
  }
  const ids: (string | number)[] = [];
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof message !== "object" || message === null || !("method" in message)) continue;
    const id = (message as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") ids.push(id);
  }
  return ids;
}

/**
 * The events that end an oversized event stream: a blank line closing the
 * partial event, then a JSON-RPC error for each request the POST carried.
 * The SDK reads an event stream apart from the request that opened it, so a
 * stream error alone reaches no caller and the call would wait out its
 * timeout; an error answer fails it now and, as an answer, stops the SDK from
 * reconnecting to resume the stream.
 * The SDK posts one message per request, so each id here is still unanswered.
 * A batched POST whose stream already answered some ids would get a second
 * answer for those.
 */
function tooLargeAnswers(ids: (string | number)[], maxBytes: number): Uint8Array {
  const message = new RemoteResponseTooLargeError(maxBytes).message;
  const events = ids.map(
    (id) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n\n`,
  );
  return new TextEncoder().encode(`\n\n${events.join("")}`);
}

/**
 * A transport fetch whose answers can never outgrow `maxBytes`. Bytes are
 * counted as they arrive, after decompression and before any reader parses
 * them, and `Content-Length` is not trusted. Past the budget the connection's
 * read is cancelled, so the host stops taking bytes instead of buffering them.
 * A body then errors with {@link RemoteResponseTooLargeError}; an event stream
 * answering a POST instead ends with an error answer for each request
 * (`tooLargeAnswers`). An event stream tied to no request, such as the
 * standalone GET stream, errors like a body.
 * This counts a stream rather than using the SDK's `readRequestBody`, which
 * buffers a whole body: the SDK reads an answer as a stream, and an event
 * stream is bounded per event, not per body.
 */
export function createResponseBudgetFetch(
  inner: FetchLike,
  maxBytes = MAX_REMOTE_RESPONSE_BYTES,
): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.body) return response;
    const media = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const isEventStream = media === "text/event-stream";
    const count = isEventStream ? sseCounter(maxBytes) : bodyCounter(maxBytes);
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          try {
            count(chunk);
          } catch (err) {
            // The request body is read only here, so an answer within the
            // budget costs no second parse of what the host sent.
            const ids = isEventStream ? requestIds(init) : [];
            if (!(err instanceof RemoteResponseTooLargeError) || ids.length === 0) throw err;
            controller.enqueue(tooLargeAnswers(ids, maxBytes));
            // Closes the readable after the answers and cancels the upstream read.
            controller.terminate();
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
