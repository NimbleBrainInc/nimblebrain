import type { Plugin } from "../../_generated/platform-schemas/plugins";
import { elsewhereNote, USE_HERE_NOTE } from "../../lib/plugin-request";
import { pluginAccount, pluginConnected } from "../../lib/plugins";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * The confirm before a person turns their own plugin on in a workspace. It names
 * the account the plugin acts as and the workspace, and says who gains what:
 * only the owner, and what the agent makes with it stays in the workspace
 * (ADR-0069 "What a grant does not change").
 *
 * In the workspace the person is in (`here`), a plugin that is not signed in
 * signs in next: confirming turns it on and then starts it. In another
 * workspace, confirming only turns it on, so the confirm says it won't work
 * there until it is signed in.
 */
export function UsePluginHereDialog({
  plugin,
  workspaceName,
  here = true,
  onClose,
  onConfirm,
}: {
  /** The plugin to turn on; the dialog is open while it is set. */
  plugin: Plugin | null;
  workspaceName: string;
  /** Whether the workspace is the one the page is in; otherwise the copy names it. */
  here?: boolean;
  onClose: () => void;
  onConfirm: (plugin: Plugin) => Promise<void>;
}) {
  const account = plugin ? pluginAccount(plugin) : undefined;
  const notSignedIn = plugin !== null && !pluginConnected(plugin);
  const note = here ? USE_HERE_NOTE : elsewhereNote(workspaceName);
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
        !notSignedIn
          ? note
          : here
            ? `${note} You'll sign in to ${plugin.displayName} next.`
            : `${note} It won't work there until you sign in to ${plugin.displayName}.`
      }
      confirmLabel={here ? "Use here" : `Use in ${workspaceName}`}
      pendingLabel="Turning on…"
      onConfirm={async () => {
        if (plugin) await onConfirm(plugin);
      }}
    />
  );
}
