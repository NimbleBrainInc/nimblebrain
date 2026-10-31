/**
 * An ACP agent served as a worker on the network, dialed over ACP's Streamable
 * HTTP transport (ADR-0057). The runtime never starts it, and the connection is
 * the same whichever agent the worker serves: what differs per agent is its
 * driver (`./driver.ts`).
 *
 * - Every request carries the runtime's connection credential, which the
 *   worker verifies against the runtime's published key set.
 * - The transport lives as long as the connection, not the run: the runtime
 *   ends a run by `session/cancel` or by closing the connection
 *   (`./acp-runtime.ts`), and both must still reach the worker after the run's
 *   signal has fired.
 * - A worker holds its connections in memory, so one that goes away mid-run
 *   (a rollout drains it, it restarts) takes the connection with it. The
 *   connection's fetch watches for that and marks the connection lost
 *   (`lost()`), which ends the run as `AgentConnectionLostError`
 *   (`./connection-lost.ts`).
 */

import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { AcpConnection } from "./driver.ts";

export interface HttpConnectionOptions {
  /** The worker's ACP endpoint. */
  url: string;
  /**
   * Mints the connection credential presented on every request, or null where
   * the installation has no run key (dev only: the worker then runs on
   * loopback with no connection check).
   */
  credential: (() => string) | null;
  /** The fetch the transport uses. Default: the global one. */
  fetch?: typeof fetch;
}

/** The header the transport names an established connection by, on every request after `initialize`. */
const CONNECTION_ID_HEADER = "acp-connection-id";

/** The statuses a worker answers for a connection it does not hold. */
const UNKNOWN_CONNECTION = new Set([404, 410]);

export function createHttpConnection(opts: HttpConnectionOptions): AcpConnection {
  return {
    async open() {
      const headers: Record<string, string> = opts.credential
        ? { authorization: `Bearer ${opts.credential()}` }
        : {};
      const watched = watchForLoss(opts.fetch ?? fetch);
      // The worker keeps nothing on disk for a session, so its cwd names nothing.
      return {
        target: createHttpStream(opts.url, { headers, fetch: watched.fetch }),
        cwd: "/",
        lost: watched.lost,
        close: async () => {},
      };
    },
  };
}

/**
 * A fetch for one connection that marks the connection lost when the worker
 * no longer holds it. It changes nothing the transport sees: every response
 * and failure reaches the transport as it came, which closes as it would
 * anyway. Only requests on an established connection count, which are the ones
 * that name it (the transport sends the connection id only after `initialize`
 * succeeded), so a worker that refuses a new connection (draining, down) is a
 * failure to connect, not a lost connection. A request the transport aborted
 * itself counts for nothing, and neither does the DELETE it sends whenever it
 * closes, whatever closed it. The connection is lost when, on such a request:
 *
 * - the worker answers that it does not know the connection (404, 410), as
 *   another worker does once a request reaches it in the owner's place;
 * - the request fails to connect or is reset;
 * - a server stream (an SSE GET) ends or breaks, as when the worker stops.
 *
 * One run holds one session, so a server stream does not end while its run
 * goes on: a stream that does is the worker going away.
 */
function watchForLoss(base: typeof fetch): { fetch: typeof fetch; lost: () => boolean } {
  let lost = false;
  const watched = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const signal = init?.signal ?? undefined;
    const counts = method !== "DELETE" && new Headers(init?.headers).has(CONNECTION_ID_HEADER);
    if (!counts) return base(input, init);
    const markUnlessAborted = () => {
      if (!signal?.aborted) lost = true;
    };
    let response: Response;
    try {
      response = await base(input, init);
    } catch (err) {
      markUnlessAborted();
      throw err;
    }
    if (UNKNOWN_CONNECTION.has(response.status)) lost = true;
    if (method !== "GET" || !response.ok || !response.body) return response;
    return new Response(watchStream(response.body, markUnlessAborted), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return { fetch: watched as typeof fetch, lost: () => lost };
}

/**
 * `body` passed through, calling `ended` when it ends or breaks. A cancel is
 * the reader's own (it stopped reading), so it is passed on and counts for nothing.
 */
function watchStream(
  body: ReadableStream<Uint8Array>,
  ended: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          ended();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        ended();
        controller.error(err);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
