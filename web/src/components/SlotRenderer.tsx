import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef } from "react";
import { getResources, uiPathFromUri } from "../api/client";
import type { BridgeHandle } from "../bridge/bridge";
import { createBridge } from "../bridge/bridge";
import {
  buildHostContext,
  buildHostExtensions,
  type ConnectorForHostContext,
} from "../bridge/host-extensions";
import type { CreateIframeOptions } from "../bridge/iframe";
import { createAppIframe } from "../bridge/iframe";
import type { AppTrailEntry } from "../bridge/schemas";
import type { BridgeCallbacks } from "../bridge/types";
import { useFileLimits } from "../context/ChatContext";
import { useTheme } from "../context/ThemeContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";
import { buildSizedHtml, DEFAULT_CONTENT_HEIGHT, RUNAWAY_HEIGHT_GUARD } from "./content-height";

interface SlotRendererProps {
  placements: PlacementEntry[];
  className?: string;
  /** If set, only show the placement matching this route */
  routeFilter?: string;
  onChat?: (message: string) => void;
  /**
   * Called with a placement's trail each time it sends
   * `ai.nimblebrain/location`, and a `navigate` that asks that same placement
   * to go to one of its trail entries.
   */
  onLocation?: (trail: AppTrailEntry[], navigate: (id: string) => void) => void;
  /**
   * A view to open inside the placement, by its stable address, sent as
   * `ai.nimblebrain/navigate`: to a placement as it mounts (the bridge holds it
   * until the app's handshake), and again whenever `key` changes on a placement
   * already mounted. `key` identifies the request, so the same address asked
   * for twice is sent twice.
   */
  target?: { id: string; key: string };
  /**
   * Whether the viewer can manage the connector these placements belong to.
   * Set only by the connector settings page; when set, it reaches the app as
   * the `connector` host-context extension. Every other mount leaves it unset.
   */
  canManage?: boolean;
  /**
   * Size each iframe to its content instead of filling the container. For a
   * placement in a flow layout (a page section), where `height: 100%` has no
   * height to resolve against.
   */
  fitContent?: boolean;
}

/**
 * Placeholder appended in place of an app whose UI resource failed to load.
 *
 * Without it a failed placement leaves the container empty, which renders as
 * blank space — the same thing a crashed app looks like, with no way to tell
 * them apart. The container is populated imperatively (the effect clears it via
 * `innerHTML`), so React state would be clobbered on the next pass; appending a
 * node keeps the failure in the DOM the iframe would have occupied.
 *
 * Text goes through `textContent`, never `innerHTML` — the label is
 * connector-authored and the message is server-supplied.
 */
function appendLoadError(container: HTMLElement, entry: PlacementEntry, err: unknown): void {
  const box = document.createElement("div");
  box.className = "flex flex-col items-center justify-center h-full gap-2 p-6 text-sm text-center";
  const title = document.createElement("span");
  title.className = "text-foreground";
  title.textContent = `${entry.label ?? entry.serverName} couldn’t be loaded.`;
  const detail = document.createElement("span");
  detail.className = "text-muted-foreground max-w-md";
  detail.textContent = err instanceof Error ? err.message : "Unknown error";
  box.append(title, detail);
  container.appendChild(box);
}

/**
 * Placeholder shown in an app's place while its UI resource is fetched.
 *
 * The resource is one inlined HTML document, often several hundred KB, so the
 * fetch can take seconds, and without this the slot is blank for all of it —
 * indistinguishable from an app that failed or has nothing to show. Built as a
 * DOM node for the same reason `appendLoadError` is: the container is populated
 * imperatively. The caller removes it once the fetch settles either way.
 */
function appendLoading(container: HTMLElement, entry: PlacementEntry): HTMLElement {
  const box = document.createElement("div");
  box.setAttribute("role", "status");
  box.className = "flex items-center justify-center h-full gap-2 p-6 text-sm text-muted-foreground";
  const spinner = document.createElement("span");
  spinner.className =
    "inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = `Loading ${entry.label ?? "app"}…`;
  box.append(spinner, label);
  container.appendChild(box);
  return box;
}

/**
 * Mount one placement's sandboxed iframe into `container` and wire its bridge.
 *
 * Extracted from the render loop so that loop stays a readable
 * fetch/mount/handle-failure sequence — the per-placement DOM and CSP plumbing
 * is incidental to it.
 */
function mountPlacement(
  container: HTMLElement,
  entry: PlacementEntry,
  resource: { html: string; metaUi?: McpUiResourceMeta },
  themeMode: CreateIframeOptions["themeMode"],
  shared: BridgeCallbacks,
  fitContent: boolean,
  onLocation: SlotRendererProps["onLocation"],
): BridgeHandle {
  const { html, metaUi } = resource;
  const iframe = createAppIframe(fitContent ? buildSizedHtml(html) : html, entry.serverName, {
    themeMode,
    connectDomains: metaUi?.csp?.connectDomains,
    resourceDomains: metaUi?.csp?.resourceDomains,
    frameDomains: metaUi?.csp?.frameDomains,
    baseUriDomains: metaUi?.csp?.baseUriDomains,
    permissions: metaUi?.permissions,
    prefersBorder: metaUi?.prefersBorder,
  });
  iframe.style.width = "100%";
  iframe.style.height = fitContent ? `${DEFAULT_CONTENT_HEIGHT}px` : "100%";
  iframe.style.display = "block";
  iframe.style.opacity = "0";
  iframe.style.transition = "opacity 200ms ease-in";

  container.appendChild(iframe);
  // Trigger fade-in after the iframe is in the DOM
  requestAnimationFrame(() => {
    iframe.style.opacity = "1";
  });

  // The trail's `navigate` must reach this placement's own bridge, which
  // exists only once `createBridge` returns; the app cannot send a location
  // before its handshake, so the binding is in place by the time it is read.
  let bridge: BridgeHandle | null = null;
  const callbacks: BridgeCallbacks = {
    ...shared,
    onLocation: (trail) => onLocation?.(trail, (id) => bridge?.navigate(id)),
  };
  if (fitContent) {
    // A non-positive report comes from an app whose root has not rendered yet;
    // keep the current height until it reports real content.
    callbacks.onResize = (reported) => {
      const h = Math.min(reported, RUNAWAY_HEIGHT_GUARD);
      if (h > 0) iframe.style.height = `${h}px`;
    };
  }
  bridge = createBridge(iframe, entry.serverName, callbacks);
  return bridge;
}

/** Send `target` to each placement's app, recording its key as sent. */
function sendTarget(
  bridges: readonly BridgeHandle[],
  target: SlotRendererProps["target"],
  sent: { current: string | null },
): void {
  if (!target) return;
  for (const bridge of bridges) bridge.navigate(target.id);
  sent.current = target.key;
}

export function SlotRenderer({
  placements,
  className,
  routeFilter,
  onChat,
  onLocation,
  target,
  canManage,
  fitContent = false,
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
  // Same reason as `workspaceRef`: the handshake reads the value current when
  // the iframe finishes loading, not the one from the render that mounted it.
  const connector: ConnectorForHostContext = canManage === undefined ? undefined : { canManage };
  const connectorRef = useRef(connector);
  connectorRef.current = connector;
  // Instance config, fixed at startup; a ref only so the callbacks built once
  // in the mount effect read it without joining that effect's dependencies.
  const uploadLimits = useFileLimits();
  const uploadLimitsRef = useRef(uploadLimits);
  uploadLimitsRef.current = uploadLimits;

  // Keep callbacks in refs so the iframe-mounting effect doesn't re-run
  // when callback identity changes (e.g. during chat streaming).
  const onChatRef = useRef(onChat);
  onChatRef.current = onChat;
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;
  const targetRef = useRef(target);
  targetRef.current = target;
  // The `key` of the last target sent, so a target is sent once whether the
  // mount or the key change delivers it.
  const sentTargetKeyRef = useRef<string | null>(null);

  const filtered = routeFilter ? placements.filter((p) => p.route === routeFilter) : placements;

  // Stable key: only re-mount iframes when the actual placements change
  const placementKey = filtered.map((p) => p.resourceUri).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-mount iframes only when placementKey changes — `filtered` is read at run time but changes identity every render (depending on it would thrash iframes), mode is read through a ref, and `fitContent` is fixed per mount site
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const bridges: BridgeHandle[] = [];

    // Every placement's bridge gets the same callbacks — each one reads a ref,
    // so none of them close over the entry. Built once outside the loop.
    const bridgeCallbacks: BridgeCallbacks = {
      onChat: (...args) => onChatRef.current?.(...args),
      getHostExtensions: () =>
        buildHostExtensions(workspaceRef.current, connectorRef.current, uploadLimitsRef.current),
      getUploadLimits: () => uploadLimitsRef.current,
    };

    // Fetch + mount one placement. A failure is contained here: it renders its
    // own message in place of the iframe and yields no bridge, so one broken app
    // never stops the placements after it from mounting.
    async function renderOne(entry: PlacementEntry): Promise<BridgeHandle | null> {
      const loading = appendLoading(container!, entry);
      try {
        // Pass the full path after ui:// (e.g., "ui://crm/main" -> "crm/main")
        const resourcePath = uiPathFromUri(entry.resourceUri);
        const resource = await getResources(entry.serverName, resourcePath).finally(() =>
          loading.remove(),
        );
        if (cancelled) return null;
        return mountPlacement(
          container!,
          entry,
          resource,
          modeRef.current,
          bridgeCallbacks,
          fitContent,
          (trail, navigate) => onLocationRef.current?.(trail, navigate),
        );
      } catch (err) {
        console.warn(`Failed to load placement ${entry.resourceUri}:`, err);
        if (!cancelled) appendLoadError(container!, entry, err);
        return null;
      }
    }

    async function renderPlacements() {
      // Clear existing content
      container!.innerHTML = "";

      for (const entry of filtered) {
        if (cancelled) break;
        const bridge = await renderOne(entry);
        if (bridge) bridges.push(bridge);
      }
      bridgesRef.current = bridges;
      if (!cancelled) sendTarget(bridges, targetRef.current, sentTargetKeyRef);
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

  // A new target for placements already mounted. One that arrives before the
  // mount finishes is sent by the mount instead, as `sentTargetKeyRef` records.
  useEffect(() => {
    if (!target || target.key === sentTargetKeyRef.current) return;
    if (bridgesRef.current.length === 0) return;
    sendTarget(bridgesRef.current, target, sentTargetKeyRef);
  }, [target]);

  // Propagate host-context changes (theme, workspace, manage flag) to mounted
  // iframes via the ext-apps `host-context-changed` notification. Iframes stay
  // mounted; apps that observe `useHostContext()` (or `useTheme()`) re-render
  // and refetch workspace-scoped data without losing local state. A role
  // change mid-session reaches a mounted settings component this way.
  useEffect(() => {
    const ctx = buildHostContext(
      mode,
      activeWorkspace,
      canManage === undefined ? undefined : { canManage },
      uploadLimits,
    );
    for (const bridge of bridgesRef.current) {
      bridge.setHostContext(ctx);
    }
  }, [mode, activeWorkspace, canManage, uploadLimits]);

  if (filtered.length === 0) return null;

  return (
    <div ref={containerRef} className={`w-full ${fitContent ? "" : "h-full"} ${className ?? ""}`} />
  );
}
