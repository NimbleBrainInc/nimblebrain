import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getResources, uiPathFromUri } from "../api/client";
import type { BridgeHandle } from "../bridge/bridge";
import { createBridge } from "../bridge/bridge";
import { buildHostExtensions } from "../bridge/host-extensions";
import { createAppIframe } from "../bridge/iframe";
import { useFileLimits } from "../context/ChatContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import type { ToolResultForUI } from "../hooks/chat-store";
import { useAppDisplayName } from "../hooks/useAppDisplayName";
import { buildSizedHtml, DEFAULT_CONTENT_HEIGHT, RUNAWAY_HEIGHT_GUARD } from "./content-height";
import { useNotice } from "./notices";

export interface InlineAppViewProps {
  appName: string;
  resourceUri: string;
  toolResult?: { tool: string; result?: ToolResultForUI };
}

/**
 * On iframe load, clear the loading overlay. Content sizing is driven by the
 * in-iframe reporter (CONTENT_RESIZE_REPORTER) via the bridge's `onResize`, not
 * by reading `iframe.contentDocument` — the opaque-origin frame is not readable
 * from the host.
 */
function attachLoadHandler(
  iframe: HTMLIFrameElement,
  isCancelled: () => boolean,
  setLoading: (v: boolean) => void,
): void {
  iframe.addEventListener(
    "load",
    () => {
      if (isCancelled()) return;
      setLoading(false);
    },
    { once: true },
  );
}

export function InlineAppView({ appName, resourceUri, toolResult }: InlineAppViewProps) {
  // Separate ref for iframe DOM — never let React manage this node's children
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<BridgeHandle | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Capture toolResult in a ref so the effect doesn't re-fire when the parent
  // re-renders with a new object reference (e.g., during streaming text deltas).
  const toolResultRef = useRef(toolResult);
  toolResultRef.current = toolResult;
  const notify = useNotice();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const nameApp = useAppDisplayName();
  // Mirror SlotRenderer: publish workspace into hostContext so apps mounted
  // here see the same `useHostContext().workspace` value as in placements.
  // Inline previews don't push host-context-changed (they're scoped to a
  // single tool result, no workspace switching mid-life), so the handshake
  // is the only delivery point.
  const { activeWorkspace } = useWorkspaceContext();
  const workspaceRef = useRef(activeWorkspace);
  workspaceRef.current = activeWorkspace;
  const uploadLimits = useFileLimits();
  const uploadLimitsRef = useRef(uploadLimits);
  uploadLimitsRef.current = uploadLimits;

  const [height, setHeight] = useState(DEFAULT_CONTENT_HEIGHT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = iframeContainerRef.current;

    async function loadInlineApp(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const path = uiPathFromUri(resourceUri);
        const { html, metaUi } = await getResources(appName, path);

        if (cancelled || !container) return;

        // Inject auto-sizing CSS before creating the iframe so full-page app
        // templates don't expand to viewport height when rendered inline.
        const sizedHtml = buildSizedHtml(html);

        const iframe = createAppIframe(sizedHtml, appName, {
          connectDomains: metaUi?.csp?.connectDomains,
          resourceDomains: metaUi?.csp?.resourceDomains,
          frameDomains: metaUi?.csp?.frameDomains,
          baseUriDomains: metaUi?.csp?.baseUriDomains,
          permissions: metaUi?.permissions,
          prefersBorder: metaUi?.prefersBorder,
        });
        iframe.style.width = "100%";
        iframe.style.height = `${DEFAULT_CONTENT_HEIGHT}px`;
        iframe.style.display = "block";
        iframe.style.maxWidth = "100%";

        // Safe: iframeContainerRef has no React children
        container.innerHTML = "";
        container.appendChild(iframe);
        iframeRef.current = iframe;

        const bridge = createBridge(iframe, appName, {
          onResize: (newHeight) => {
            // Ignore non-positive heights. The in-iframe reporter fires once on
            // DOMContentLoaded — when an async-rendering app's root is still
            // empty, `scrollHeight` ≈ 0 — so without this lower bound the widget
            // collapses to ~0px until content mounts and the ResizeObserver
            // reports again. The upper bound is only the runaway guard; the
            // widget otherwise takes whatever height its content reports.
            const h = Math.min(newHeight, RUNAWAY_HEIGHT_GUARD);
            if (h > 0) {
              setHeight(h);
              iframe.style.height = `${h}px`;
            }
          },
          onInitialized: () => {
            const tr = toolResultRef.current;
            if (tr?.result) {
              bridge.sendToolResult(tr.result);
            }
          },
          getHostExtensions: () =>
            buildHostExtensions(workspaceRef.current, undefined, uploadLimitsRef.current),
          getUploadLimits: () => uploadLimitsRef.current,
          onNotify: (notice) => notifyRef.current({ ...notice, source: nameApp(appName) }),
        });
        bridgeRef.current = bridge;

        // Auto-sizing is driven by the in-iframe reporter → onResize (above);
        // this just clears the loading overlay on load. Async data loads and
        // dynamic content resize automatically via the reporter's ResizeObserver.
        // Tool result is sent separately when the widget confirms handshake via onInitialized.
        attachLoadHandler(iframe, () => cancelled, setLoading);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load inline view";
        setError(msg);
        setLoading(false);
      }
    }

    loadInlineApp();

    return () => {
      cancelled = true;
      bridgeRef.current?.destroy();
      bridgeRef.current = null;
      iframeRef.current = null;
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [appName, resourceUri, nameApp]);

  return (
    <div className="w-full max-w-full my-2 rounded-sm overflow-hidden border border-border bg-card">
      <div
        className="relative w-full transition-[height] duration-150"
        style={{ height: `${height}px` }}
      >
        {/* Iframe container — React never renders children here */}
        <div ref={iframeContainerRef} className="absolute inset-0" />

        {/* React-managed overlays — separate from iframe DOM */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground text-sm bg-muted">
            <Loader2 className="w-4 h-4 text-processing animate-spin" />
            Loading view...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-destructive text-sm bg-destructive/5 p-2">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
