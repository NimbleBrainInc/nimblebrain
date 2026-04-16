import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useChatContext } from "./ChatContext";

type PanelState = "closed" | "sidebar" | "fullscreen";

export interface ChatPanelContextValue {
  panelState: PanelState;
  panelWidth: number;
  /** Open the panel. If conversationId provided, load that conversation. */
  openPanel: (conversationId?: string) => void;
  /** Close the panel. */
  closePanel: () => void;
  /** Toggle between closed and sidebar. */
  togglePanel: () => void;
  /** Toggle between sidebar and fullscreen. */
  toggleFullscreen: () => void;
  /** Set panel width (for resize handle). */
  setPanelWidth: (width: number) => void;
}

const LS_STATE_KEY = "nb:chatPanelState";
const LS_WIDTH_KEY = "nb:chatPanelWidth";
const DEFAULT_WIDTH = 380;

function readState(): PanelState {
  const stored = localStorage.getItem(LS_STATE_KEY);
  if (stored === "closed" || stored === "sidebar" || stored === "fullscreen") {
    return stored;
  }
  return "closed";
}

function readWidth(): number {
  const stored = localStorage.getItem(LS_WIDTH_KEY);
  if (stored) {
    const n = Number(stored);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_WIDTH;
}

const ChatPanelContext = createContext<ChatPanelContextValue | null>(null);

export interface ChatPanelProviderProps {
  children: ReactNode;
}

/** Provider that owns chat panel state (open/closed/fullscreen, width). Must be nested inside ChatProvider. */
export function ChatPanelProvider({ children }: ChatPanelProviderProps) {
  const chat = useChatContext();
  const [panelState, setPanelStateRaw] = useState<PanelState>(readState);
  const [panelWidth, setPanelWidthRaw] = useState<number>(readWidth);

  // Use a ref for loadConversation so openPanel's identity doesn't change
  // when the chat context value changes during streaming.
  const loadConversationRef = useRef(chat.loadConversation);
  loadConversationRef.current = chat.loadConversation;

  const setPanelState = useCallback((state: PanelState) => {
    setPanelStateRaw(state);
    localStorage.setItem(LS_STATE_KEY, state);
  }, []);

  const setPanelWidth = useCallback((width: number) => {
    setPanelWidthRaw(width);
    localStorage.setItem(LS_WIDTH_KEY, String(width));
  }, []);

  const openPanel = useCallback(
    (conversationId?: string) => {
      setPanelState("sidebar");
      if (conversationId) {
        loadConversationRef.current(conversationId);
      }
    },
    [setPanelState],
  );

  const closePanel = useCallback(() => {
    setPanelState("closed");
  }, [setPanelState]);

  const togglePanel = useCallback(() => {
    setPanelState(panelState === "closed" ? "sidebar" : "closed");
  }, [setPanelState, panelState]);

  const toggleFullscreen = useCallback(() => {
    setPanelState(panelState === "fullscreen" ? "sidebar" : "fullscreen");
  }, [setPanelState, panelState]);

  const value = useMemo<ChatPanelContextValue>(
    () => ({
      panelState,
      panelWidth,
      openPanel,
      closePanel,
      togglePanel,
      toggleFullscreen,
      setPanelWidth,
    }),
    [panelState, panelWidth, openPanel, closePanel, togglePanel, toggleFullscreen, setPanelWidth],
  );

  return <ChatPanelContext value={value}>{children}</ChatPanelContext>;
}

/** Consume the ChatPanelContext. Throws if used outside a ChatPanelProvider. */
export function useChatPanelContext(): ChatPanelContextValue {
  const ctx = useContext(ChatPanelContext);
  if (!ctx) {
    throw new Error("useChatPanelContext must be used within a ChatPanelProvider");
  }
  return ctx;
}
