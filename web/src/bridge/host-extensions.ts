// ---------------------------------------------------------------------------
// Host-context extension builders
//
// NimbleBrain-specific keys we publish into the ext-apps `hostContext` bag.
// The bridge stays workspace-agnostic; this module owns what extensions get
// surfaced to apps. Used by both `SlotRenderer` (placement iframes) and
// `InlineAppView` (inline tool-result iframes) so the host-context payload
// is consistent across mount points — apps that read
// `useHostContext().workspace` see the same value regardless of how the
// iframe was mounted.
//
// Spec-standardized fields (`theme`, `styles`) are NOT defined here. The
// bridge merges them in itself and they always win over same-named keys
// returned from `buildHostExtensions`, so this layer only ever owns the
// non-spec keys.
// ---------------------------------------------------------------------------

import { getThemeTokens } from "./theme";

export type WorkspaceForHostContext = { id: string; name: string } | null;

/**
 * Non-spec extension keys to merge into the `ui/initialize` hostContext
 * response. Bridge merges these alongside theme/styles; spec fields win
 * on key collisions.
 */
export function buildHostExtensions(workspace: WorkspaceForHostContext): Record<string, unknown> {
  return workspace ? { workspace: { id: workspace.id, name: workspace.name } } : {};
}

/**
 * Full hostContext payload for `host-context-changed` notifications. Spec
 * fields (`theme`, `styles`) plus extensions, in one shot. Spread order
 * means extensions are written first; spec fields override on collision.
 */
export function buildHostContext(
  mode: "light" | "dark",
  workspace: WorkspaceForHostContext,
): Record<string, unknown> {
  const tokens = getThemeTokens(mode);
  return {
    ...buildHostExtensions(workspace),
    theme: mode,
    styles: { variables: tokens },
  };
}
