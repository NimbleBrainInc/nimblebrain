import type { Plugin } from "../../_generated/platform-schemas/plugins";
import { USE_HERE_NOTE } from "../../lib/plugin-request";
import { pluginAccount, pluginConnected } from "../../lib/plugins";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * The confirm before a person turns their own plugin on in a workspace. It names
 * the account the plugin acts as and the workspace, and says who gains what:
 * only the owner, and what the agent makes with it stays in the workspace
 * (ADR-0069 "What a grant does not change"). When the plugin is not signed in,
 * it says the sign-in comes next: confirming turns it on and then starts it.
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
  const signInNext = plugin !== null && !pluginConnected(plugin);
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
      description={
        signInNext
          ? `${USE_HERE_NOTE} You'll sign in to ${plugin.displayName} next.`
          : USE_HERE_NOTE
      }
      confirmLabel="Use here"
      pendingLabel="Turning on…"
      onConfirm={async () => {
        if (plugin) await onConfirm(plugin);
      }}
    />
  );
}
