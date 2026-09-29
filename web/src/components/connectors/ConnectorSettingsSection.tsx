import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { SlotRenderer } from "../SlotRenderer";

/**
 * The connector's own settings component, rendered as the last section of its
 * settings page from the connector's `settings` placement.
 *
 * - **One per connector.** The first `settings` placement by priority whose
 *   server is this connector renders; any other is ignored. `forSlot` returns
 *   placements sorted by priority.
 * - **Rendered for every member who can reach the page.** `canManage` is not a
 *   visibility gate here. It reaches the component as the `connector` host-context
 *   extension, so the component can disable controls the viewer cannot use; the
 *   server still decides every call.
 * - **Nothing when the connector declares no `settings` placement**, or while
 *   the shell still holds another workspace's placements mid-switch.
 *
 * The iframe renders flush, without card chrome: a connector UI draws its own
 * complete content, and a host card around it reads as cards-in-cards.
 */
export function ConnectorSettingsSection({
  serverName,
  name,
  canManage,
}: {
  serverName: string;
  name: string;
  canManage: boolean;
}) {
  const shell = useShellContext();
  const { activeWorkspace } = useWorkspaceContext();

  if (!shell || shell.shellWorkspaceId !== activeWorkspace?.id) return null;
  // `forSlot` also returns `settings.<x>` slots, which the contract does not
  // define; only the exact slot is a settings section.
  const placement = shell
    .forSlot("settings")
    .find((p) => p.slot === "settings" && p.serverName === serverName);
  if (!placement) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {name}
      </h2>
      <SlotRenderer placements={[placement]} canManage={canManage} fitContent />
    </section>
  );
}
