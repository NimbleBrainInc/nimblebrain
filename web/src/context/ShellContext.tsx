import { createContext, useContext } from "react";
import type { PlacementEntry } from "../types";

export interface ShellContextValue {
  forSlot: (slot: string) => PlacementEntry[];
  mainRoutes: () => PlacementEntry[];
  /**
   * The workspace id the current placements reflect, or `undefined` before the
   * first shell load. A per-workspace consumer (e.g. the overview page's app
   * grid) must compare this to its own workspace id: when they differ the
   * shell hasn't caught up yet, so the consumer should render a
   * loading state, NOT an empty state. `forSlot` returns the *previous*
   * workspace's placements during that window.
   *
   * This is the only readiness signal consumers need. Placements load behind
   * the mounted app, for the first workspace focused as for a switch, and a
   * failed load is handled one level up (`BootstrappedShell` shows the error),
   * so a context consumer only ever has to wait on this.
   */
  shellWorkspaceId: string | undefined;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShellContext(): ShellContextValue | null {
  return useContext(ShellContext);
}
