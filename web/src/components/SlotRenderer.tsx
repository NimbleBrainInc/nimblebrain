import { useEffect, useRef, useSyncExternalStore } from "react";
import { getResources, uiPathFromUri } from "../api/client";
import type { BridgeHandle } from "../bridge/bridge";
import { createBridge } from "../bridge/bridge";
import { buildHostContext, buildHostExtensions } from "../bridge/host-extensions";
import { createAppIframe } from "../bridge/iframe";
import type { UiChatContext } from "../bridge/types";
import { useTheme } from "../context/ThemeContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { chatStore } from "../hooks/chat-store";
import type { PlacementEntry } from "../types";

interface SlotRendererProps {
  placements: PlacementEntry[];
  className?: string;
  /** If set, only show the placement matching this route */
  routeFilter?: string;
  onChat?: (message: string, context?: UiChatContext) => void;
  onNavigate?: (route: string) => void;
  onPromptAction?: (prompt: string) => void;
  /**
   * One-shot: force a cache-bypassing data load on first handshake.
   * Only the home route sets this (from `?force=1`); inert elsewhere.
   */
  forceRefresh?: boolean;
}

export function SlotRenderer({
  placements,
  className,
  routeFilter,
  onChat,
  onNavigate,
  onPromptAction,
  forceRefresh = false,
}: SlotRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgesRef = useRef<BridgeHandle[]>([]);
  const { mode } = useTheme();
  const { activeWorkspace } = useWorkspaceContext();
  // Keep mode in a ref so the async renderPlacements() reads the latest value
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Refs let `getHostExtensions` read the live workspace at handshake time
  // (which happens after the iframe loads, possibly several effect cycles
  // after createBridge). Without the ref, the closure would capture a stale
  // workspace from the render that mounted the iframe.
  const workspaceRef = useRef(activeWorkspace);
  workspaceRef.current = activeWorkspace;

  // Keep callbacks in refs so the iframe-mounting effect doesn't re-run
  // when callback identity changes (e.g. during chat streaming).
  const onChatRef = useRef(onChat);
  onChatRef.current = onChat;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onPromptActionRef = useRef(onPromptAction);
  onPromptActionRef.current = onPromptAction;

  // Mirror `forceRefresh` into a ref so `getHostExtensions` reads it at
  // handshake time — the same reason `workspaceRef`/`modeRef` exist.
  const forceRefreshRef = useRef(forceRefresh);
  forceRefreshRef.current = forceRefresh;

  // Conversations currently streaming an assistant turn in this tab. Pushed
  // into hostContext so the conversations list can show a per-row indicator.
  // The store identity is stable between membership changes, so this only
  // re-pushes when a conversation starts/stops streaming — not per delta.
  const streamingIds = useSyncExternalStore(
    chatStore.subscribeStreamingIds,
    chatStore.getStreamingIds,
  );
  const streamingIdsRef = useRef(streamingIds);
  streamingIdsRef.current = streamingIds;

  const filtered = routeFilter ? placements.filter((p) => p.route === routeFilter) : placements;

  // Stable key: only re-mount iframes when the actual placements change
  const placementKey = filtered.map((p) => p.resourceUri).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-mount iframes only when placementKey changes — `filtered` is read at run time but changes identity every render (depending on it would thrash iframes), and mode/streaming/forceRefresh are read through refs
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
            getHostExtensions: () =>
              buildHostExtensions(
                workspaceRef.current,
                forceRefreshRef.current,
                streamingIdsRef.current,
              ),
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
  }, [placementKey]);

  // Propagate host-context changes (theme + workspace) to mounted iframes
  // via the ext-apps `host-context-changed` notification. Iframes stay
  // mounted; apps that observe `useHostContext()` (or `useTheme()`) re-render
  // and refetch workspace-scoped data without losing local state.
  useEffect(() => {
    const ctx = buildHostContext(mode, activeWorkspace, streamingIds);
    for (const bridge of bridgesRef.current) {
      bridge.setHostContext(ctx);
    }
  }, [mode, activeWorkspace, streamingIds]);

  if (filtered.length === 0) return null;

  return <div ref={containerRef} className={`w-full h-full ${className ?? ""}`} />;
}
