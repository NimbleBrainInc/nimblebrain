import { useEffect, useRef } from "react";
import { getResources, uiPathFromUri } from "../api/client";
import type { BridgeHandle } from "../bridge/bridge";
import { createBridge } from "../bridge/bridge";
import { createAppIframe } from "../bridge/iframe";
import { getThemeTokens } from "../bridge/theme";
import type { UiChatContext } from "../bridge/types";
import { useTheme } from "../context/ThemeContext";
import type { PlacementEntry } from "../types";

interface SlotRendererProps {
  placements: PlacementEntry[];
  className?: string;
  /** If set, only show the placement matching this route */
  routeFilter?: string;
  onChat?: (message: string, context?: UiChatContext) => void;
  onNavigate?: (route: string) => void;
  onPromptAction?: (prompt: string) => void;
}

export function SlotRenderer({
  placements,
  className,
  routeFilter,
  onChat,
  onNavigate,
  onPromptAction,
}: SlotRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgesRef = useRef<BridgeHandle[]>([]);
  const { mode } = useTheme();
  // Keep mode in a ref so the async renderPlacements() reads the latest value
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Keep callbacks in refs so the iframe-mounting effect doesn't re-run
  // when callback identity changes (e.g. during chat streaming).
  const onChatRef = useRef(onChat);
  onChatRef.current = onChat;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onPromptActionRef = useRef(onPromptAction);
  onPromptActionRef.current = onPromptAction;

  const filtered = routeFilter ? placements.filter((p) => p.route === routeFilter) : placements;

  // Stable key: only re-mount iframes when the actual placements change
  const placementKey = filtered.map((p) => p.resourceUri).join(",");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const bridges: BridgeHandle[] = [];

    async function renderPlacements() {
      // Clear existing content
      container!.innerHTML = "";

      for (const entry of filtered) {
        if (cancelled) break;
        try {
          // Pass the full path after ui:// (e.g., "ui://crm/main" -> "crm/main")
          const resourcePath = uiPathFromUri(entry.resourceUri);
          const { html, metaUi } = await getResources(entry.serverName, resourcePath);
          if (cancelled) break;

          const iframe = createAppIframe(html, entry.serverName, {
            themeMode: modeRef.current,
            connectDomains: metaUi?.csp?.connectDomains,
            resourceDomains: metaUi?.csp?.resourceDomains,
            frameDomains: metaUi?.csp?.frameDomains,
            baseUriDomains: metaUi?.csp?.baseUriDomains,
            permissions: metaUi?.permissions,
            prefersBorder: metaUi?.prefersBorder,
          });
          iframe.style.width = "100%";
          iframe.style.height = "100%";
          iframe.style.display = "block";
          iframe.style.opacity = "0";
          iframe.style.transition = "opacity 200ms ease-in";

          container!.appendChild(iframe);
          // Trigger fade-in after the iframe is in the DOM
          requestAnimationFrame(() => {
            iframe.style.opacity = "1";
          });

          const bridge = createBridge(iframe, entry.serverName, {
            onChat: (...args) => onChatRef.current?.(...args),
            onNavigate: (...args) => onNavigateRef.current?.(...args),
            onPromptAction: (...args) => onPromptActionRef.current?.(...args),
          });
          bridges.push(bridge);
        } catch (err) {
          console.warn(`Failed to load placement ${entry.resourceUri}:`, err);
        }
      }
      bridgesRef.current = bridges;
    }

    renderPlacements();

    return () => {
      cancelled = true;
      bridges.forEach((b) => {
        b.destroy();
      });
      if (container) container.innerHTML = "";
    };
    // Only re-mount iframes when placements change, not when callbacks change.
    // Callbacks are accessed via refs so bridges always call the latest version.
    // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks accessed via refs
  }, [placementKey]);

  // Separate effect: propagate theme changes to all mounted iframes.
  // Only depends on `mode` so theme toggles do NOT re-mount iframes.
  useEffect(() => {
    const tokens = getThemeTokens(mode);
    for (const bridge of bridgesRef.current) {
      bridge.setHostContext({ theme: mode, styles: { variables: tokens } });
    }
  }, [mode]);

  if (filtered.length === 0) return null;

  return <div ref={containerRef} className={`w-full h-full ${className ?? ""}`} />;
}
