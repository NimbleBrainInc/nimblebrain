import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getResources, uiPathFromUri } from "../api/client";
import type { BridgeHandle } from "../bridge/bridge";
import { createBridge } from "../bridge/bridge";
import { buildHostExtensions } from "../bridge/host-extensions";
import { createAppIframe } from "../bridge/iframe";
import { useWorkspaceContext } from "../context/WorkspaceContext";

import type { ToolResultForUI } from "../hooks/useChat";

export interface InlineAppViewProps {
  appName: string;
  resourceUri: string;
  toolResult?: { tool: string; result?: ToolResultForUI };
}

const DEFAULT_HEIGHT = 200;
// Runaway guard, NOT a layout budget. An inline app renders at whatever height
// its content reports, the same as it would in any other MCP host.
//
// Any bound shorter than the content hides it *silently*: INLINE_SIZING_CSS sets
// `overflow:hidden` inside the frame and the wrapper clips too, so there is no
// scrollbar and no affordance — a truncated card is indistinguishable from a tool
// that returned less. That is why the ceiling sits far above real content instead
// of at a layout budget; it exists only so an app reporting an absurd height
// cannot mint a multi-million-pixel element.
//
// It also terminates a growth loop this component cannot otherwise stop:
// INLINE_SIZING_CSS neutralizes `100vh` on `html,body` only, so a descendant with
// `min-height:100vh` resolves against the iframe viewport, and an app shaped as
// that element plus a trailing sibling of height K reports H+K, then H+2K, and so
// on. Such an app is misshapen for an inline widget either way; the guard bounds
// how badly it fails.
const RUNAWAY_HEIGHT_GUARD = 20_000;

// Force content-based sizing in inline widget iframes.
// Full-page app templates often set height: 100vh or min-height: 100% which
// causes the iframe to report the full viewport height instead of content height.
const INLINE_SIZING_CSS = `<style>html,body{height:auto!important;min-height:0!important;overflow:hidden!important;margin:0!important}</style>`;

// Report content height to the host from INSIDE the iframe. The app frame is
// sandboxed without `allow-same-origin` (opaque origin), so the host cannot
// read `iframe.contentDocument` to measure it — the content must report its own
// size. A ResizeObserver posts `ui/notifications/size-changed` (the ext-apps
// resize protocol the bridge already routes to `onResize`) on every content
// change plus once on start; the host floors at >0 and otherwise honors it.
// Reports `body.scrollHeight` (true content height, so the widget shrinks as
// well as grows) — NOT `documentElement.scrollHeight`, whose viewport floor
// ratchets the height and never lets it shrink. An empty root (async app,
// pre-mount) reports ~0, which the host's `onResize` lower bound ignores. This
// is host-injected wrapper markup, not app code; CSP `script-src 'unsafe-inline'`
// permits it, and `injectCSP` replaces any app-declared CSP so it always runs.
const INLINE_RESIZE_REPORTER = `<script>(function(){function r(){try{var b=document.body;parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:b?b.scrollHeight:document.documentElement.scrollHeight}},"*");}catch(e){}}function s(){try{new ResizeObserver(r).observe(document.body||document.documentElement);}catch(e){}r();}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",s);}else{s();}})();</script>`;

/** Inject inline auto-sizing CSS + a content-height reporter into app HTML so full-page templates size to content, not the viewport. */
function buildSizedHtml(html: string): string {
  const inject = `${INLINE_SIZING_CSS}\n${INLINE_RESIZE_REPORTER}`;
  const headPattern = /<head([^>]*)>/i;
  return headPattern.test(html)
    ? html.replace(headPattern, (m) => `${m}\n${inject}`)
    : `${inject}\n${html}`;
}

/**
 * On iframe load, clear the loading overlay. Content sizing is driven by the
 * in-iframe reporter (INLINE_RESIZE_REPORTER) via the bridge's `onResize`, not
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
  // Mirror SlotRenderer: publish workspace into hostContext so apps mounted
  // here see the same `useHostContext().workspace` value as in placements.
  // Inline previews don't push host-context-changed (they're scoped to a
  // single tool result, no workspace switching mid-life), so the handshake
  // is the only delivery point.
  const { activeWorkspace } = useWorkspaceContext();
  const workspaceRef = useRef(activeWorkspace);
  workspaceRef.current = activeWorkspace;

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
        iframe.style.height = `${DEFAULT_HEIGHT}px`;
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
          getHostExtensions: () => buildHostExtensions(workspaceRef.current),
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
  }, [appName, resourceUri]);

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
