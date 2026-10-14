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

import type { FileLimits } from "../types";
import { getHostFontFaceCss } from "./fonts";
import { getThemeTokens, type ThemeTokens } from "./theme";

export type WorkspaceForHostContext = {
  id: string;
  name: string;
} | null;

/**
 * What the viewer may do with the connector whose settings component is
 * mounted. Supplied only by the connector settings page, so every other mount
 * point's payload carries no `connector` key.
 *
 * `canManage` is the same rule the page's host sections gate on: workspace
 * membership role `admin`, with no org-admin bypass. It lets a component
 * disable controls it knows the viewer cannot use. It is not the permission:
 * the server decides every call on its own.
 */
export type ConnectorForHostContext = { canManage: boolean } | undefined;

/**
 * The limits a picker upload is held to: the instance's `files` config, which
 * the host's picker enforces before it uploads anything. Published as the
 * `uploads` extension so an app can state them before the user picks.
 */
export type UploadLimits = Pick<FileLimits, "maxFileSize" | "maxTotalSize">;

/**
 * Non-spec extension keys to merge into the `ui/initialize` hostContext
 * response. Bridge merges these alongside theme/styles; spec fields win
 * on key collisions.
 */
export function buildHostExtensions(
  workspace: WorkspaceForHostContext,
  connector?: ConnectorForHostContext,
  uploads?: UploadLimits,
): Record<string, unknown> {
  const ext: Record<string, unknown> = workspace
    ? {
        workspace: {
          id: workspace.id,
          name: workspace.name,
        },
      }
    : {};
  if (connector) ext.connector = { canManage: connector.canManage };
  if (uploads) {
    ext.uploads = { maxFileSize: uploads.maxFileSize, maxTotalSize: uploads.maxTotalSize };
  }
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
  connector?: ConnectorForHostContext,
  uploads?: UploadLimits,
): Record<string, unknown> {
  const tokens = getThemeTokens(mode);
  return {
    ...buildHostExtensions(workspace, connector, uploads),
    theme: mode,
    styles: buildHostStyles(tokens),
  };
}
