import { createContext, useContext } from "react";
import type { PlacementEntry } from "../types";

export interface ShellContextValue {
  forSlot: (slot: string) => PlacementEntry[];
  mainRoutes: () => PlacementEntry[];
  /**
   * The workspace id the current placements reflect, or `undefined` before the
   * first shell load. A per-workspace consumer (e.g. the overview page's app
   * grid) must compare this to its own workspace id: when they differ the
   * shell hasn't caught up to a switch yet, so the consumer should render a
   * loading state, NOT an empty state. `forSlot` returns the *previous*
   * workspace's placements during that window.
   *
   * This is the only readiness signal consumers need. The shell's `loading` /
   * `error` are handled one level up (`BootstrappedShell` gates the whole app
   * on them), so by the time any context consumer renders, loading is false
   * and there's no error — a workspace *switch* keeps loading false and swaps
   * `shellWorkspaceId` instead, which is exactly the window this exposes.
   */
  shellWorkspaceId: string | undefined;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShellContext(): ShellContextValue | null {
  return useContext(ShellContext);
}
