import type { Plugin } from "../../_generated/platform-schemas/plugins";
import { pluginAccount } from "../../lib/plugins";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * The confirm before a person turns their own plugin on in a workspace. It names
 * the account the plugin acts as and the workspace, and says who gains what:
 * only the owner, and what the agent makes with it stays in the workspace
 * (ADR-0069 "What a grant does not change").
 */
export function UsePluginHereDialog({
  plugin,
  workspaceName,
  onClose,
  onConfirm,
}: {
  /** The plugin to turn on; the dialog is open while it is set. */
  plugin: Plugin | null;
  workspaceName: string;
  onClose: () => void;
  onConfirm: (plugin: Plugin) => Promise<void>;
}) {
  const account = plugin ? pluginAccount(plugin) : undefined;
  return (
    <ConfirmDialog
      open={plugin !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        plugin
          ? `Use ${plugin.displayName}${account ? ` (${account})` : ""} in ${workspaceName}?`
          : ""
      }
      description="Only you can use it here; other members can't. What your agent does with it is saved in this workspace, private to you unless you share it."
      confirmLabel="Use here"
      pendingLabel="Turning on…"
      onConfirm={async () => {
        if (plugin) await onConfirm(plugin);
      }}
    />
  );
}
