// ---------------------------------------------------------------------------
// ToolWorkspacesContext — Stage 2 / T013
//
// Surfaces the set of workspaces whose tools are visible in the
// identity-bound chat surface (TOOLS FROM line in the composer footer).
//
// Why a separate context, not just `useWorkspaceContext`?
//
//   The TOOLS FROM line answers a different question than the sidebar:
//   "from which workspaces are tools being aggregated into this chat?"
//   In Stage 2 this set is structurally identical to the user's
//   workspace set (per T005's aggregator topology — every workspace
//   the identity belongs to contributes tools). But the spec's
//   adversarial test pins the topology, not the identity ("a regression
//   that pinned the badges to the active workspace instead of the
//   aggregator would look correct in single-workspace tests but break
//   in multi-workspace — pin the multi-workspace case").
//
//   Keeping the source of truth here means the footer's reactivity
//   contract is explicit (aggregator-invalidation events update the
//   set), and tests can stub the topology independently of the
//   identity's workspace list without forking WorkspaceContext.
//
// Default provider derives the set from `useWorkspaceContext` —
// matching the T005 invariant that the aggregator includes every
// workspace the identity belongs to. Tests inject their own value
// directly via `ToolWorkspacesContext.Provider`.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { useWorkspaceContext, type WorkspaceInfo } from "./WorkspaceContext";

export interface ToolWorkspacesContextValue {
  /**
   * Workspaces whose tools are currently visible in chat. The composer
   * footer's TOOLS FROM line renders one badge per entry, in the same
   * order. Empty when the identity has no workspaces (loading or
   * fresh-account states).
   */
  toolWorkspaces: WorkspaceInfo[];
}

const ToolWorkspacesContext = createContext<ToolWorkspacesContextValue | null>(null);

export const ToolWorkspacesProvider = ToolWorkspacesContext.Provider;

/**
 * Read the tool-contributing workspace set. Falls back to the user's
 * workspace list from `WorkspaceContext` when no provider is mounted
 * (default Stage 2 behavior — aggregator topology mirrors identity
 * membership). Tests wrap their tree in `ToolWorkspacesProvider` with
 * a stubbed value to exercise multi-workspace + invalidation paths.
 */
export function useToolWorkspaces(): ToolWorkspacesContextValue {
  const injected = useContext(ToolWorkspacesContext);
  const wsCtx = useWorkspaceContext();
  return useMemo<ToolWorkspacesContextValue>(() => {
    if (injected) return injected;
    return { toolWorkspaces: wsCtx.workspaces };
  }, [injected, wsCtx.workspaces]);
}

/**
 * Convenience wrapper that mounts a provider with a specific list.
 * Used by tests to make multi-workspace + addition cases readable.
 */
export function TestToolWorkspacesProvider({
  value,
  children,
}: {
  value: ToolWorkspacesContextValue;
  children: ReactNode;
}) {
  return <ToolWorkspacesProvider value={value}>{children}</ToolWorkspacesProvider>;
}
