// ---------------------------------------------------------------------------
// AppWithChat — iframe renderer for a single app placement.
//
// Scope is deliberately narrow. The chat panel — toggle, sliding
// sidebar/fullscreen, resize handle — and the `marginRight` push-over
// that makes room for it are all shell-level (`ChatChrome` and
// `ShellLayout`), so they behave identically on every route. Don't pull
// any of that back in here; this component renders one app and nothing
// about the panel's own layout.
//
// What stays here, because it needs the focused app:
//   - `SlotRenderer` — renders the placement's iframe
//   - `handleChat` — the iframe→shell channel for "send this from inside the
//     app". It is the one place a focused app is known, so it stamps the
//     app's `AppContext` on outgoing messages.
//   - publishing the focused app to `FocusedAppContext`, so the globally
//     mounted chat panel can stamp the same `AppContext` on messages
//     typed into the main composer (not just the in-app channel).
//   - publishing the app's trail (`ai.nimblebrain/location`) to
//     `AppLocationContext`, so the top bar shows its title and back control.
//   - First-page-load chat-store restoration. `getSavedConversationId`
//     fires once per module evaluation (= per page load) and re-attaches
//     to the last in-flight conversation so the SSE viewer reconnects.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router-dom";
import type { AppTrailEntry } from "../bridge/schemas";
import { useAppLocation } from "../context/AppLocationContext";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useFocusedApp } from "../context/FocusedAppContext";
import { getSavedConversationId, setSavedConversationId } from "../lib/active-conversation-storage";
import { useIsMobile } from "../lib/hooks/use-is-mobile";
import { appTargetFrom } from "../lib/open-app";
import { cn } from "../lib/utils";
import type { AppContext, PlacementEntry } from "../types";
import { SlotRenderer } from "./SlotRenderer";

/**
 * Module-once guard: restore conversation state only on a fresh page load, not
 * on every client-side app navigation (which remounts AppWithChat). A page
 * reload resets the module, re-arming the restore.
 */
let restoredLastConversation = false;

/** Reopen the last-viewed conversation (per-tab), so an in-flight turn resumes its viewer. */
function restoreSavedConversation(chat: ReturnType<typeof useChatContext>) {
  const saved = getSavedConversationId();
  // Hydrate without forcing the panel open — its visibility is restored
  // independently from ChatPanelContext's persisted state. When the panel
  // is (re)opened it shows this conversation.
  if (saved) void chat.loadConversation(saved);
}

interface AppWithChatProps {
  placement: PlacementEntry;
}

const TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const TRANSITION_FULLSCREEN = "350ms cubic-bezier(0.4, 0, 0.2, 1)";

export function AppWithChat({ placement }: AppWithChatProps) {
  const { panelState, openPanel, toggleFullscreen } = useChatPanelContext();

  const chat = useChatContext();
  const isMobile = useIsMobile();
  const { setFocusedApp } = useFocusedApp();
  const { setAppLocation } = useAppLocation();
  const location = useLocation();

  // Collapse fullscreen when navigating to a different route
  const prevPathnameRef = useRef(location.pathname);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to pathname changes, panelState/toggleFullscreen are intentionally excluded
  useEffect(() => {
    if (location.pathname !== prevPathnameRef.current) {
      prevPathnameRef.current = location.pathname;
      if (panelState === "fullscreen") {
        toggleFullscreen();
      }
    }
  }, [location.pathname]);

  // Deep-link: open chat from ?chat=<conversationId> on mount. Otherwise, on a
  // fresh page load, reopen the last-viewed conversation (per-tab, via
  // sessionStorage) so an in-flight turn's stream/indicator resumes —
  // loadConversation re-subscribes and the server's `isActive` drives the
  // bubble. Module-once so app-to-app navigation doesn't re-trigger it.
  const deepLinkHandled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
  useEffect(() => {
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const chatId = new URLSearchParams(window.location.search).get("chat");
    if (chatId) {
      openPanel(chatId);
      return;
    }
    if (restoredLastConversation) return;
    restoredLastConversation = true;
    restoreSavedConversation(chat);
  }, []);

  // Persist the active conversation id (per-tab) so a reload can reopen it.
  // Cleared automatically when a new/draft chat is active (conversationId null).
  useEffect(() => {
    setSavedConversationId(chat.conversationId);
  }, [chat.conversationId]);

  const appContext = useMemo<AppContext>(
    () => ({
      appName: placement.label || placement.serverName,
      serverName: placement.serverName,
    }),
    [placement.label, placement.serverName],
  );

  // Publish this app as the focused one while it's mounted, so messages
  // typed into the global chat panel carry its `AppContext` (the panel
  // can't know the focused app on its own — see ChatChrome's header).
  // Clear on unmount / route change so non-app routes stamp nothing.
  useEffect(() => {
    setFocusedApp(appContext);
    return () => setFocusedApp(null);
  }, [appContext, setFocusedApp]);

  // A view to open inside the app, carried by `openApp` in the router state.
  // Keyed by the navigation, so asking for the same view again re-sends it.
  const targetId = appTargetFrom(location.state);
  const target = useMemo(
    () => (targetId ? { id: targetId, key: location.key } : undefined),
    [targetId, location.key],
  );

  // The routed app's trail, cleared whenever the app on screen changes so the
  // bar never shows a trail that app did not send. That is a new placement as
  // well as an unmount: sibling app routes render this same element, so React
  // Router reuses the instance across app-to-app navigation.
  const handleLocation = useCallback(
    (trail: AppTrailEntry[], navigate: (id: string) => void) => setAppLocation({ trail, navigate }),
    [setAppLocation],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the placement is the trigger, not a value read
  useEffect(() => () => setAppLocation(null), [setAppLocation, placement.resourceUri]);

  const handleChat = useCallback(
    (message: string) => {
      if (panelState === "closed") {
        openPanel();
      }
      chat.sendMessage(message, appContext);
    },
    [panelState, openPanel, chat, appContext],
  );

  const isSidebar = panelState === "sidebar";
  const isFullscreen = panelState === "fullscreen";
  // On a phone the sidebar is a full-width overlay that covers the app.
  // Covering is presentation, not lifetime: the app area stays mounted in
  // every panel state, so the iframe, its bridge, and the view's pushed
  // state survive. Only unmounting this component (or a new placement)
  // tears the view down. Hidden with `visibility`, not `display: none`, so
  // the iframe keeps its size and the app sees no resize while covered.
  const coveredOnMobile = isMobile && isSidebar;

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* App area. marginRight (chat panel push-over) is handled at the
          shell level on <main>; AppWithChat keeps only the iframe-specific
          styling: opacity/blur when fullscreen chat covers the iframe, and
          invisible + inert while the mobile sidebar covers it. */}
      <div
        data-testid="app-with-chat-area"
        className={cn(
          "flex-1 h-full min-w-0",
          isFullscreen &&
            "opacity-30 scale-[0.98] blur-sm pointer-events-none transition-all duration-350 ease-out",
          coveredOnMobile && "invisible",
        )}
        {...(coveredOnMobile ? { inert: true, "aria-hidden": true } : {})}
        style={{
          transition: isFullscreen
            ? `opacity ${TRANSITION_FULLSCREEN}, transform ${TRANSITION_FULLSCREEN}, filter ${TRANSITION_FULLSCREEN}`
            : `opacity ${TRANSITION_STANDARD}, transform ${TRANSITION_STANDARD}, filter ${TRANSITION_STANDARD}`,
        }}
      >
        <SlotRenderer
          placements={[placement]}
          className="w-full h-full"
          onChat={handleChat}
          onLocation={handleLocation}
          target={target}
        />
      </div>
    </div>
  );
}
