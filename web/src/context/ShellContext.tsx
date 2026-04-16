import { createContext, useContext } from "react";
import type { PlacementEntry } from "../types";

export interface ShellContextValue {
  forSlot: (slot: string) => PlacementEntry[];
  mainRoutes: () => PlacementEntry[];
}

const ShellContext = createContext<ShellContextValue | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShellContext(): ShellContextValue | null {
  return useContext(ShellContext);
}
