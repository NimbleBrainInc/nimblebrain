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
    async open() {
      const headers: Record<string, string> = opts.credential
        ? { authorization: `Bearer ${opts.credential()}` }
        : {};
      // The worker keeps nothing on disk for a session, so its cwd names nothing.
      return {
        target: createHttpStream(opts.url, { headers }),
        cwd: "/",
        close: async () => {},
      };
    },
  };
}
