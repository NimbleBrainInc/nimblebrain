import { useEffect, useRef } from "react";
import type { BridgeHandle } from "../bridge/bridge";
import {
  buildHostContext,
  type ConnectorForHostContext,
  type UploadLimits,
  type WorkspaceForHostContext,
} from "../bridge/host-extensions";
import type { ThemeMode } from "../bridge/theme";

/**
 * Send `ui/notifications/host-context-changed` to an app view's mounted
 * iframes whenever what the host context carries changes: the theme, the
 * workspace, the connector's manage flag, the upload limits.
 *
 * An app iframe stays mounted across all of these, and the `ui/initialize`
 * handshake is read once, so this notification is the only way a change
 * reaches an app that has already connected. Every mount point (`SlotRenderer`,
 * `InlineAppView`) sends it through here, so each pushes the same payload on
 * the same triggers.
 *
 * `getBridges` is read when a change fires, never as a dependency, so a caller
 * can hand over a fresh closure on every render. A bridge still mid-handshake
 * holds the push and delivers it once the app has initialized.
 */
export function useHostContextSync(
  getBridges: () => Iterable<BridgeHandle>,
  mode: ThemeMode,
  workspace: WorkspaceForHostContext,
  connector: ConnectorForHostContext,
  uploads: UploadLimits | undefined,
): void {
  const getBridgesRef = useRef(getBridges);
  getBridgesRef.current = getBridges;
  const canManage = connector?.canManage;

  useEffect(() => {
    const ctx = buildHostContext(
      mode,
      workspace,
      canManage === undefined ? undefined : { canManage },
      uploads,
    );
    for (const bridge of getBridgesRef.current()) bridge.setHostContext(ctx);
  }, [mode, workspace, canManage, uploads]);
}
