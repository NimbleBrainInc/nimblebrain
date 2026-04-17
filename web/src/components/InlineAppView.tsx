import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getResources } from "../api/client";
import type { BridgeHandle } from "../bridge/bridge";
import { createBridge } from "../bridge/bridge";
import { createAppIframe } from "../bridge/iframe";

import type { ToolResultForUI } from "../hooks/useChat";

export interface InlineAppViewProps {
  appName: string;
  resourceUri: string;
  toolResult?: { tool: string; result?: ToolResultForUI };
}

const DEFAULT_HEIGHT = 200;
const MAX_HEIGHT = 600;

// Force content-based sizing in inline widget iframes.
// Full-page app templates often set height: 100vh or min-height: 100% which
// causes the iframe to report the full viewport height instead of content height.
const INLINE_SIZING_CSS = `<style>html,body{height:auto!important;min-height:0!important;overflow:hidden!important;margin:0!important}</style>`;

export function InlineAppView({ appName, resourceUri, toolResult }: InlineAppViewProps) {
  // Separate ref for iframe DOM — never let React manage this node's children
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<BridgeHandle | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  // Capture toolResult in a ref so the effect doesn't re-fire when the parent
  // re-renders with a new object reference (e.g., during streaming text deltas).
  const toolResultRef = useRef(toolResult);
  toolResultRef.current = toolResult;

  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = iframeContainerRef.current;

    async function loadInlineApp(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const path = resourceUri.replace(/^ui:\/\//, "");
        const html = await getResources(appName, path);

        if (cancelled || !container) return;

        // Inject auto-sizing CSS before creating the iframe so full-page app
        // templates don't expand to viewport height when rendered inline.
        const headPattern = /<head([^>]*)>/i;
        const sizedHtml = headPattern.test(html)
          ? html.replace(headPattern, (m) => `${m}\n${INLINE_SIZING_CSS}`)
          : `${INLINE_SIZING_CSS}\n${html}`;

        const iframe = createAppIframe(sizedHtml, appName);
        iframe.style.width = "100%";
        iframe.style.height = `${DEFAULT_HEIGHT}px`;
        iframe.style.display = "block";
        iframe.style.maxWidth = "100%";

        // Safe: iframeContainerRef has no React children
        container.innerHTML = "";
        container.appendChild(iframe);
        iframeRef.current = iframe;

        const bridge = createBridge(iframe, appName, {
          onResize: (newHeight) => {
            // App's explicit resize hint — still respect it but cap it
            const h = Math.min(newHeight, MAX_HEIGHT);
            setHeight(h);
            iframe.style.height = `${h}px`;
          },
          onInitialized: () => {
            const tr = toolResultRef.current;
            if (tr?.result) {
              bridge.sendToolResult(tr.result);
            }
          },
        });
        bridgeRef.current = bridge;

        // After the iframe loads: auto-size based on actual rendered content.
        // ResizeObserver on the body fires whenever content height changes,
        // so async data loads and dynamic content are handled automatically.
        iframe.addEventListener(
          "load",
          () => {
            if (cancelled) return;
            setLoading(false);

            requestAnimationFrame(() => {
              if (cancelled) return;
              const body = iframe.contentDocument?.body;
              if (!body) return;

              const syncHeight = () => {
                if (cancelled) return;
                const h = Math.min(body.scrollHeight, MAX_HEIGHT);
                if (h > 0) {
                  setHeight(h);
                  iframe.style.height = `${h}px`;
                }
              };

              syncHeight();

              const ro = new ResizeObserver(syncHeight);
              ro.observe(body);
              roRef.current = ro;
            });

            // Tool result is sent when the widget confirms handshake via onInitialized callback
          },
          { once: true },
        );
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
      roRef.current?.disconnect();
      roRef.current = null;
      bridgeRef.current?.destroy();
      bridgeRef.current = null;
      iframeRef.current = null;
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [appName, resourceUri]);

  return (
    <div className="w-full max-w-full my-2 rounded-lg overflow-hidden border border-border bg-card">
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
