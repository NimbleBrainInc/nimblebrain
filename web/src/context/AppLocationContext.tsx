import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import type { AppTrailEntry } from "../bridge/schemas";

/**
 * Where the routed app says it is, for the shell's top bar.
 *
 * An app reports its whole trail, root first, over `ai.nimblebrain/location`
 * (`bridge/extensions.ts`); `AppWithChat` publishes it here with a `navigate`
 * bound to that app's bridge. The top bar shows the trail's last label as the
 * title and, when the trail is deeper than one, the entries above it as a
 * breadcrumb (a back control where the bar is narrow). With no trail (any non-app route, or an app that
 * sends none) the bar falls back to the route's own name.
 *
 * A standalone context, like `FocusedAppContext`, so a trail change re-renders
 * only the bar and the app view.
 */
export interface AppLocation {
  /** The app's trail, root first; the last entry is the current view. */
  trail: AppTrailEntry[];
  /** Ask the app to go to one of its own trail entries, by `id`. */
  navigate: (id: string) => void;
}

export interface AppLocationContextValue {
  appLocation: AppLocation | null;
  /** Publish (or clear, with `null`) the routed app's location. */
  setAppLocation: (location: AppLocation | null) => void;
}

const NULL_VALUE: AppLocationContextValue = {
  appLocation: null,
  setAppLocation: () => {},
};

const AppLocationContext = createContext<AppLocationContextValue | null>(null);

export function AppLocationProvider({ children }: { children: ReactNode }) {
  const [appLocation, setAppLocation] = useState<AppLocation | null>(null);
  const value = useMemo<AppLocationContextValue>(
    () => ({ appLocation, setAppLocation }),
    [appLocation],
  );
  return <AppLocationContext.Provider value={value}>{children}</AppLocationContext.Provider>;
}

/** Read the routed app's location. Inert outside a provider (tests, isolated views). */
export function useAppLocation(): AppLocationContextValue {
  return useContext(AppLocationContext) ?? NULL_VALUE;
}
