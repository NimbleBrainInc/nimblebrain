import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * The confirm before one of the viewer's plugins stops acting in a workspace,
 * asked from the plugin's page.
 */
export function StopUsingDialog({
  pluginName,
  workspaceName,
  here,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** The plugin's name; empty while the dialog is closed. */
  pluginName: string;
  workspaceName: string;
  /** Whether the workspace is the one the page is in, which the question then calls "here". */
  here: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Throws to keep the dialog open with the error shown; the caller closes it on success. */
  onConfirm: () => Promise<void> | void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        here ? `Stop using ${pluginName} here?` : `Stop using ${pluginName} in ${workspaceName}?`
      }
      description={`Your agent can't use it in ${workspaceName} until you turn it back on. It stays connected to your account.`}
      confirmLabel={here ? "Stop using here" : "Stop using"}
      pendingLabel="Stopping…"
      onConfirm={onConfirm}
    />
  );
}
