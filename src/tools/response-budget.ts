import type { FetchLike } from "@modelcontextprotocol/client";

/**
 * The most a remote connector may send in one answer. A host budget, not a
 * protocol limit: it leaves room for several 10 MiB files after base64.
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
 * stream of small events passes and one oversized event does not.
 */
function sseCounter(maxBytes: number): (chunk: Uint8Array) => void {
  let eventBytes = 0;
  let lineBytes = 0;
  let afterCr = false;
  const read = (byte: number) => {
    if (++eventBytes > maxBytes) throw new RemoteResponseTooLargeError(maxBytes);
    // The LF of a CRLF belongs to the line its CR already ended.
    const crlf = afterCr && byte === LF;
    afterCr = byte === CR;
    if (crlf) return;
    if (byte !== LF && byte !== CR) {
      lineBytes++;
      return;
    }
    if (lineBytes === 0) eventBytes = 0;
    lineBytes = 0;
  };
  return (chunk) => {
    for (const byte of chunk) read(byte);
  };
}

/** Counts one whole body: a JSON answer, an error page, anything not a stream of events. */
function bodyCounter(maxBytes: number): (chunk: Uint8Array) => void {
  let bytes = 0;
  return (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new RemoteResponseTooLargeError(maxBytes);
  };
}

/**
 * A transport fetch whose answers can never outgrow `maxBytes`. Bytes are
 * counted as they arrive, after decompression and before any reader parses
 * them, and `Content-Length` is not trusted. Past the budget the body errors
 * with {@link RemoteResponseTooLargeError} and the connection's read is
 * cancelled, so the host stops taking bytes instead of buffering them.
 */
export function createResponseBudgetFetch(
  inner: FetchLike,
  maxBytes = MAX_REMOTE_RESPONSE_BYTES,
): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.body) return response;
    const media = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const count = media === "text/event-stream" ? sseCounter(maxBytes) : bodyCounter(maxBytes);
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          count(chunk);
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
