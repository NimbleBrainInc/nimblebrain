import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import type { AppContext } from "../types";

/**
 * Tracks the app the user is currently viewing alongside chat, so the
 * globally-mounted chat panel (`ChatChrome`) can stamp its `AppContext`
 * on messages typed into the main composer — not just on the in-app
 * "ask about this" channel (`AppWithChat.handleChat`).
 *
 * Without this, a message typed into the side panel while looking at an
 * app carries no `appContext`, so the backend never resolves a focused
 * app (`runtime.ts` gates the whole resolution on `request.appContext`)
 * and the agent can't see the app's visible state (e.g. which document
 * the user has open). The app publishes itself here on mount; the panel
 * reads it on send.
 *
 * Deliberately a standalone context (not folded into `ShellContext`) so
 * focus changes re-render only the two participants — the app view and
 * the chat panel — and not every shell consumer.
 */
export interface FocusedAppContextValue {
  /** The app the user is currently viewing, or `null` on non-app routes. */
  focusedApp: AppContext | null;
  /** Publish (or clear, with `null`) the currently-viewed app. */
  setFocusedApp: (app: AppContext | null) => void;
}

const NULL_VALUE: FocusedAppContextValue = {
  focusedApp: null,
  setFocusedApp: () => {},
};

const FocusedAppContext = createContext<FocusedAppContextValue | null>(null);

export function FocusedAppProvider({ children }: { children: ReactNode }) {
  const [focusedApp, setFocusedApp] = useState<AppContext | null>(null);
  const value = useMemo<FocusedAppContextValue>(
    () => ({ focusedApp, setFocusedApp }),
    [focusedApp],
  );
  return <FocusedAppContext.Provider value={value}>{children}</FocusedAppContext.Provider>;
}

/**
 * Read the focused-app context. Returns an inert value (no-op setter,
 * `null` app) when rendered outside a provider, so components like
 * `ChatChrome` and `AppWithChat` work in isolation (tests, storybook).
 */
export function useFocusedApp(): FocusedAppContextValue {
  return useContext(FocusedAppContext) ?? NULL_VALUE;
}
