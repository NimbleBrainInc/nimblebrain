import { useCallback, useEffect, useRef } from "react";
import type { UiDataChangedMessage } from "../bridge/types";
import { debug } from "../lib/debug";
import type { DataChangedEvent } from "../types";

/** A single change record buffered before dispatch. */
interface DataChange {
  source: "agent";
  server: string;
  tool: string;
  timestamp: string;
}

const DEBOUNCE_MS = 100;

/**
 * Hook that buffers `data.changed` SSE events and forwards them to
 * matching iframes via postMessage.
 *
 * When a `data.changed` event arrives, it is buffered for up to 100ms.
 * After the debounce window closes, a single `ui/datachanged` message
 * is sent to each iframe whose `data-app` attribute matches the event's
 * server name.
 *
 * Returns a stable callback to be wired into the SSE event handler.
 */
export function useDataSync(): (event: DataChangedEvent) => void {
  const bufferRef = useRef<Map<string, DataChange[]>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush buffered changes to matching iframes
  const flush = useCallback(() => {
    const buffer = bufferRef.current;
    if (buffer.size === 0) return;

    const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe[data-app]");
    // Answers: "are the iframes I expect actually in the DOM with the right
    // data-app?" — the most common cause of UIs that don't update. Gated on
    // `localStorage.nb_debug=sync` (see web/src/lib/debug.ts).
    debug("sync", `flush ${buffer.size} buffer entries, ${iframes.length} iframes`, {
      bufferKeys: [...buffer.keys()],
      iframeApps: Array.from(iframes).map((f) => f.dataset.app),
    });

    for (const iframe of iframes) {
      const appName = iframe.dataset.app;
      if (!appName) continue;

      const changes = buffer.get(appName);
      if (!changes || changes.length === 0) continue;

      // Send one JSON-RPC 2.0 message per buffered change, matching SS4.3 format
      for (const change of changes) {
        const message: UiDataChangedMessage = {
          jsonrpc: "2.0",
          method: "synapse/data-changed",
          params: {
            source: "agent",
            server: change.server,
            tool: change.tool,
          },
        };
        debug("sync", `→ iframe[data-app="${appName}"] ${change.server}/${change.tool}`);
        iframe.contentWindow?.postMessage(message, "*");
      }
    }

    buffer.clear();
    timerRef.current = null;
  }, []);

  // Clean up pending timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Stable callback for receiving data.changed events
  const onDataChanged = useCallback(
    (event: DataChangedEvent) => {
      // Confirms the SSE connection is delivering `data.changed` events to
      // the browser. If this never fires, the break is upstream (server sink
      // wrap not installed, SSE connection closed, etc.).
      debug("sync", `SSE data.changed server=${event.server} tool=${event.tool}`);
      const change: DataChange = {
        source: "agent",
        server: event.server,
        tool: event.tool,
        timestamp: event.timestamp,
      };

      const buffer = bufferRef.current;
      const existing = buffer.get(event.server);
      if (existing) {
        existing.push(change);
      } else {
        buffer.set(event.server, [change]);
      }

      // Start debounce timer if not already running
      if (timerRef.current === null) {
        timerRef.current = setTimeout(flush, DEBOUNCE_MS);
      }
    },
    [flush],
  );

  return onDataChanged;
}
