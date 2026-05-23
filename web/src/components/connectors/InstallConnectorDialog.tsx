import { useEffect, useMemo, useRef, useState } from "react";
import { type DirectoryEntry, installConnector } from "../../api/client";
import {
  type WorkspaceTarget,
  WorkspaceTargetPicker,
  workspacesEligibleForInstall,
} from "./WorkspaceTargetPicker";
import { useWorkspaceContext } from "../../context/WorkspaceContext";

/**
 * Connector install dialog. Replaces the previous one-click install +
 * implicit-scope flow with an explicit workspace target picker. The
 * dialog is the single decision surface for "which workspace gets this
 * connector?"; the `manage_connectors.install` tool action hard-errors
 * when no `wsId` is supplied (Stage 1 precedent: `startBundleSource`).
 *
 * Preselection (UX hint, not a contract):
 *   - `defaultBinding === "personal"`  → the user's personal workspace
 *     (if present) is preselected. Personal-typical connectors (Gmail,
 *     Calendar, Granola, etc.) carry this binding in the catalog.
 *   - `defaultBinding === "workspace"` → no preselection; the user
 *     must pick. Shared connectors don't have an obvious "current"
 *     target — the active workspace switcher is the wrong source post-
 *     T009 (it's going away), so we leave the picker empty.
 *
 * Typed confirmation gate:
 *   - Personal-workspace target → Install enabled immediately.
 *   - Any non-personal target → user must type the workspace's display
 *     name to enable Install. Case-INSENSITIVE comparison after
 *     trimming both sides — the gate is friction, not key-entry
 *     precision. Documented inline so a future change is deliberate.
 *
 * State reset on close: every transient piece of state (selection,
 * typed confirmation, error, busy) is cleared every time the dialog
 * (re)opens. Without this, closing while typing `Helix` and reopening
 * for `Acme` would leave the Acme dialog with `Helix` in the input —
 * the wrong "type-to-confirm" affordance and an adversarial
 * misinstall risk. Pinned by a test.
 */
export interface InstallConnectorDialogProps {
  entry: DirectoryEntry;
  open: boolean;
  onClose: () => void;
  /** Called after a successful install with the result so the caller can route. */
  onInstalled: (result: { serverName: string; wsId: string }) => void;
}

export function InstallConnectorDialog({
  entry,
  open,
  onClose,
  onInstalled,
}: InstallConnectorDialogProps) {
  const wsCtx = useWorkspaceContext();
  // Eligible workspaces (admin-role only). Personal workspaces always
  // pass this filter (Stage 1 invariant: owner is admin).
  const eligible = useMemo(
    () => workspacesEligibleForInstall(wsCtx.workspaces),
    [wsCtx.workspaces],
  );

  // Preselection is driven by `defaultBinding`. Wrapped in useMemo so
  // both the initial-mount and reopen branches see the same heuristic
  // result for the same inputs.
  const preselection = useMemo(() => preselectWorkspaceId(entry, eligible), [entry, eligible]);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(preselection);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstFocusRef = useRef<HTMLDivElement | null>(null);

  // Reset transient state every time the dialog (re)opens. Closing the
  // dialog with stale state and reopening for a different connector
  // (or the same connector after the user backed out) must NOT carry
  // the prior typed-confirmation forward — that would let a user who
  // typed `Helix` into the previous dialog accidentally install into
  // a different workspace named `Helix Apps` whose substring matches
  // the leftover text. Adversarial regression caught by test.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preselection is intentionally re-applied on every open via [open] only — preselection is itself memoized over (entry, eligible)
  useEffect(() => {
    if (open) {
      setSelectedWorkspaceId(preselection);
      setConfirmText("");
      setError(null);
      setBusy(false);
      setTimeout(() => firstFocusRef.current?.focus(), 0);
    }
  }, [open]);

  // Esc closes; mirror OperatorSetupModal's behavior.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const selectedWorkspace = eligible.find((ws) => ws.id === selectedWorkspaceId) ?? null;
  const requiresTypedConfirmation = !!selectedWorkspace && !selectedWorkspace.isPersonal;
  const confirmationMatches =
    !selectedWorkspace ||
    !requiresTypedConfirmation ||
    typedConfirmationMatches(confirmText, selectedWorkspace.name);
  const canSubmit = !busy && !!selectedWorkspace && confirmationMatches;

  const submit = async () => {
    if (!selectedWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      const res = await installConnector(entry, selectedWorkspace.id);
      onInstalled({ serverName: res.serverName, wsId: res.wsId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-connector-title"
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md p-5"
      >
        <h2 id="install-connector-title" className="text-base font-semibold">
          Install {entry.name}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Pick the workspace that will hold this connector's credentials. Workspace members will
          share access to anything installed here.
        </p>

        <div ref={firstFocusRef} tabIndex={-1} className="outline-none mt-4">
          <div className="text-xs font-medium mb-2">Target workspace</div>
          <WorkspaceTargetPicker
            workspaces={eligible}
            selectedWorkspaceId={selectedWorkspaceId}
            onChange={setSelectedWorkspaceId}
            disabled={busy}
          />
        </div>

        {requiresTypedConfirmation && (
          <div className="mt-4">
            <label className="block text-xs font-medium">
              Type <span className="font-mono">{selectedWorkspace.name}</span> to confirm install
              into this shared workspace
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={busy}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              className="mt-1 w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="install-typed-confirmation"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Case-insensitive match against the workspace's display name. Personal-workspace
              installs skip this confirmation.
            </p>
          </div>
        )}

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            data-testid="install-confirm-button"
            className="text-sm px-3 py-1.5 rounded border border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Decide which workspace (if any) to preselect when the dialog opens.
 *
 * The `defaultBinding` field on a `DirectoryEntry` is a UX hint the
 * catalog publisher attaches to declare "this connector is usually
 * personal" (`"personal"`, e.g. Gmail) or "this connector is usually
 * shared" (`"workspace"`, e.g. Asana). The picker turns the hint into
 * a default selection so the common path is one click; the user is
 * always free to change it.
 *
 * Rules:
 *   - `defaultBinding === "personal"` and a personal workspace exists
 *     in the eligible set → preselect it.
 *   - `defaultBinding === "workspace"` → no preselection. Shared
 *     connectors don't have an obvious "current" target — the active
 *     workspace switcher in the header is being removed (T009), so
 *     we don't reach for ambient state. The user picks explicitly.
 *   - Catalog missing `defaultBinding` (defensive) → no preselection.
 */
export function preselectWorkspaceId(
  entry: DirectoryEntry,
  eligible: WorkspaceTarget[],
): string | null {
  if (entry.defaultBinding === "personal") {
    const personal = eligible.find((ws) => ws.isPersonal);
    return personal?.id ?? null;
  }
  return null;
}

/**
 * Case-insensitive typed confirmation check. Both sides are trimmed of
 * leading/trailing whitespace, then lower-cased, then compared for
 * exact equality. The intent is a friction gate ("do you really mean
 * to install into the team's shared workspace?"), not key-entry
 * precision — case sensitivity would punish a user who types `helix`
 * for a workspace named `Helix` despite the intent being clearly
 * matched. Documented inline so a future tightening is deliberate.
 */
export function typedConfirmationMatches(typed: string, workspaceName: string): boolean {
  return typed.trim().toLowerCase() === workspaceName.trim().toLowerCase();
}
