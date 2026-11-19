import { useEffect, useState } from "react";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * Who an install is for: the person installing it (a personal connector on
 * their own account, granted into this workspace) or everyone in the workspace
 * (one shared account). ADR-0069.
 */
export type InstallAudience = "personal" | "workspace";

/**
 * Ask whom an install is for before running it. Opens on "Just me". "Everyone
 * in <workspace>" is listed only for a member who may write the workspace and
 * only while the workspace has no install of its own; a member who may not is
 * told who can. `onInstall` throws to keep the dialog
 * open with the error, and the caller closes it on success or navigates away.
 */
export function InstallAudienceDialog({
  open,
  connectorName,
  workspaceName,
  canWriteWorkspace,
  installedForEveryone = false,
  onOpenChange,
  onInstall,
}: {
  open: boolean;
  connectorName: string;
  workspaceName: string;
  canWriteWorkspace: boolean;
  /** The workspace already has its own install: only "Just me" is left to choose. */
  installedForEveryone?: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (audience: InstallAudience) => Promise<void>;
}) {
  const [audience, setAudience] = useState<InstallAudience>("personal");
  // Each open starts on the default: a choice from an earlier open was for
  // another connector.
  useEffect(() => {
    if (open) setAudience("personal");
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Install ${connectorName}`}
      description="Who is it for?"
      confirmLabel="Install"
      pendingLabel="Installing…"
      onConfirm={() => onInstall(audience)}
    >
      <div role="radiogroup" aria-label="Install for" className="space-y-2">
        <AudienceOption
          value="personal"
          selected={audience === "personal"}
          onSelect={setAudience}
          label="Just me"
          hint={`Signs in with your own account. Only you can use it, here and in any workspace you turn it on in.`}
        />
        {installedForEveryone ? (
          <p className="text-muted-foreground">
            Everyone in {workspaceName} already uses it with one shared account.
          </p>
        ) : canWriteWorkspace ? (
          <AudienceOption
            value="workspace"
            selected={audience === "workspace"}
            onSelect={setAudience}
            label={`Everyone in ${workspaceName}`}
            hint="Signs in with one account that everyone in this workspace uses."
          />
        ) : (
          <p className="text-muted-foreground">
            A workspace admin can install it for everyone in {workspaceName}.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

function AudienceOption({
  value,
  selected,
  onSelect,
  label,
  hint,
}: {
  value: InstallAudience;
  selected: boolean;
  onSelect: (value: InstallAudience) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2 rounded-sm border border-border/60 p-3 has-[:checked]:border-foreground/40">
      <input
        type="radio"
        name="install-audience"
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        className="mt-0.5"
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
