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

export type WorkspaceForHostContext = {
  id: string;
  name: string;
  /**
   * Whether the active room is the user's personal room. Apps that scope a
   * view to the current room read this to fold legacy artifacts with no
   * stamped room into Personal (absent room === personal, per the
   * permission-boundaries spec). This is the app's OWN active room — not a
   * roster of other rooms — so it crosses no wall.
   */
  isPersonal?: boolean;
} | null;

/**
 * Non-spec extension keys to merge into the `ui/initialize` hostContext
 * response. Bridge merges these alongside theme/styles; spec fields win
 * on key collisions.
 *
 * `forceRefresh` is delivered only here (initialize), never in
 * `host-context-changed`, so an app reads it once at handshake and treats
 * later workspace switches as normal cache-backed loads.
 */
export function buildHostExtensions(
  workspace: WorkspaceForHostContext,
  forceRefresh = false,
  streamingConversationIds: string[] = [],
): Record<string, unknown> {
  const ext: Record<string, unknown> = workspace
    ? {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          isPersonal: workspace.isPersonal ?? false,
        },
      }
    : {};
  if (forceRefresh) ext.forceRefresh = true;
  // Conversations with an in-flight assistant turn in this browser tab. Apps
  // (e.g. the conversations list) render a live "streaming" affordance per
  // row. Ephemeral, tab-local — not persisted, not from the server.
  if (streamingConversationIds.length > 0) {
    ext.streamingConversationIds = streamingConversationIds;
  }
  return ext;
}

/**
 * Full hostContext payload for `host-context-changed` notifications. Spec
 * fields (`theme`, `styles`) plus extensions, in one shot. Spread order
 * means extensions are written first; spec fields override on collision.
 */
export function buildHostContext(
  mode: "light" | "dark",
  workspace: WorkspaceForHostContext,
  streamingConversationIds: string[] = [],
): Record<string, unknown> {
  const tokens = getThemeTokens(mode);
  return {
    ...buildHostExtensions(workspace, false, streamingConversationIds),
    theme: mode,
    styles: { variables: tokens },
  };
}
