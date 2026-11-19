// ---------------------------------------------------------------------------
// The confirmation after a connector's OAuth sign-in.
//
// The OAuth callback renders nothing: it redirects to the connectors page it
// started from with `?connected=<server name>`. The page confirms the
// connection with a notice, in the app's own theme.
//
// The callback hands over the authorization code and redirects at once; the
// token exchange finishes after the page loads. So the notice waits for the
// connector itself to settle (the page re-reads its list meanwhile), and says
// what actually happened: connected, or failed. A name the page does not list
// announces nothing, so a crafted link cannot raise a false confirmation.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useNotice } from "../notices";

/** The query parameter the OAuth callbacks name the connected connector in. */
export const CONNECTED_PARAM = "connected";

/** How often the page re-reads its list while a connector settles, and for how long. */
const POLL_MS = 1000;
const POLL_LIMIT = 15;

/** A listed connector, reduced to what the confirmation needs. */
export interface ReturnedConnector {
  serverName: string;
  displayName: string;
  /** `pending` while the connection is still being established. */
  state: "connected" | "failed" | "pending";
}

export type ReturnOutcome =
  | { kind: "connected" | "failed"; name: string }
  | { kind: "wait" }
  | { kind: "absent" };

/** What to say about `serverName`, given the page's current list. */
export function returnOutcome(
  serverName: string,
  connectors: readonly ReturnedConnector[],
): ReturnOutcome {
  const connector = connectors.find((c) => c.serverName === serverName);
  if (!connector) return { kind: "absent" };
  if (connector.state === "pending") return { kind: "wait" };
  return { kind: connector.state, name: connector.displayName || connector.serverName };
}

/**
 * Confirm the connector named by `?connected=` once it settles. `connectors` is
 * null while the page's list is loading. `refresh` re-reads the list; it must
 * be stable across renders.
 */
export function useConnectedNotice(
  connectors: readonly ReturnedConnector[] | null,
  refresh: () => void,
): void {
  const [params, setParams] = useSearchParams();
  const [pending, setPending] = useState<string | null>(null);
  const notify = useNotice();

  // Take the name out of the URL, so a reload or Back never confirms twice.
  useEffect(() => {
    const name = params.get(CONNECTED_PARAM);
    if (name === null) return;
    setPending(name || null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(CONNECTED_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);

  useEffect(() => {
    if (!pending || !connectors) return;
    const outcome = returnOutcome(pending, connectors);
    if (outcome.kind === "wait") return;
    setPending(null);
    if (outcome.kind === "connected") {
      notify({ level: "success", title: `Connected to ${outcome.name}` });
    } else if (outcome.kind === "failed") {
      notify({ level: "error", title: `Couldn't connect to ${outcome.name}` });
    }
  }, [pending, connectors, notify]);

  // Re-read the list while the connector settles. One that never settles in
  // time is left to its row's own status.
  useEffect(() => {
    if (!pending) return;
    let reads = 0;
    const timer = setInterval(() => {
      reads += 1;
      if (reads > POLL_LIMIT) {
        clearInterval(timer);
        setPending(null);
        return;
      }
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);
}
