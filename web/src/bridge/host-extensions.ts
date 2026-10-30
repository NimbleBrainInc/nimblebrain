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
 * What the viewer may do with the connector a mounted app belongs to, sent as
 * the `connector` host-context key. Supplied by two mounts: the connector
 * settings page, to the connector's settings component, and an app's own page
 * (a routed sidebar placement, such as `sidebar.apps`), to that connector's
 * app. Every other mount point's payload (an inline tool result, an identity
 * app, which belongs to no connector) carries no `connector` key.
 *
 * - `allowedTools`: the bare names of this connector's tools the viewer may
 *   call, from the server's installed-connector entry, decided by the same gate
 *   that refuses a call (`admin_tools` against the viewer's workspace role, and
 *   the host-only lifecycle handlers). An app gates a control on whether the
 *   tool behind it is listed. It names tools, never a role, so a change to who
 *   may call what changes the list and no app. Sent on both mounts once the
 *   entry has loaded.
 * - `canManage`: the older, coarser signal, the viewer's workspace role
 *   (`admin`, no org-admin bypass). Settings page only. Prefer `allowedTools`.
 *
 * Neither is the permission: the server decides every call on its own.
 */
export type ConnectorForHostContext =
  | { canManage?: boolean; allowedTools?: readonly string[] }
  | undefined;

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
  if (connector && (connector.canManage !== undefined || connector.allowedTools)) {
    ext.connector = {
      ...(connector.canManage !== undefined ? { canManage: connector.canManage } : {}),
      ...(connector.allowedTools ? { allowedTools: [...connector.allowedTools] } : {}),
    };
  }
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
