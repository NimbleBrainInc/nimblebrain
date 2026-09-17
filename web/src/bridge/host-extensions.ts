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

import { getHostFontFaceCss } from "./fonts";
import { getThemeTokens, type ThemeTokens } from "./theme";

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
 */
export function buildHostExtensions(workspace: WorkspaceForHostContext): Record<string, unknown> {
  const ext: Record<string, unknown> = workspace
    ? {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          isPersonal: workspace.isPersonal ?? false,
        },
      }
    : {};
  return ext;
}

/**
 * The spec's `hostContext.styles`: the theme's CSS variables, and the host's
 * `@font-face` CSS where there is any.
 *
 * A token names a font family; it cannot load one, and the iframe inherits no
 * `@font-face` from the shell. Shipping the rules alongside the variables is
 * what makes `--font-sans` and `--font-mono` resolve to the real thing instead
 * of falling through to `system-ui`.
 *
 * `css` is omitted rather than sent empty when there are no faces — an app
 * injects whatever string it is handed, and an empty `<style>` element is a
 * thing to look at later and wonder about.
 */
export function buildHostStyles(variables: ThemeTokens): Record<string, unknown> {
  const fonts = getHostFontFaceCss();
  return { variables, ...(fonts ? { css: { fonts } } : {}) };
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
    styles: buildHostStyles(tokens),
  };
}
