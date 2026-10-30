/**
 * An ACP agent served as a worker on the network, dialed over ACP's Streamable
 * HTTP transport (ADR-0057). The runtime never starts it, and the connection is
 * the same whichever agent the worker serves: what differs per agent is its
 * driver (`./driver.ts`).
 *
 * - Every request carries the runtime's connection credential, which the
 *   worker verifies against the runtime's published key set.
 * - Every request ends with the run, so a cancel during session setup, before
 *   the runtime's own cancel listener exists, aborts the request in flight.
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
}

export function createHttpConnection(opts: HttpConnectionOptions): AcpConnection {
  return {
    async open(run) {
      const headers: Record<string, string> = opts.credential
        ? { authorization: `Bearer ${opts.credential()}` }
        : {};
      const signal = run.config.signal;
      const fetch = signal
        ? Object.assign(
            (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
              globalThis.fetch(input, {
                ...init,
                signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
              }),
            { preconnect: globalThis.fetch.preconnect },
          )
        : undefined;
      // The worker keeps nothing on disk for a session, so its cwd names nothing.
      return {
        target: createHttpStream(opts.url, { headers, ...(fetch ? { fetch } : {}) }),
        cwd: "/",
        close: async () => {},
      };
    },
  };
}
