import { useEffect, useRef, useState } from "react";
import { type DirectoryEntry, setupConnectorOperator } from "../../api/client";

/**
 * Workspace operator OAuth app setup. The form is the same whether
 * the catalog entry is being configured for the first time or
 * rotated: clientId is pre-fillable, clientSecret never echoes (we
 * don't have the plaintext server-side anyway — the credential store
 * wraps it in `Redacted`). Submitting writes both pieces atomically
 * via `manage_connectors.setup_operator`.
 *
 * The modal is intentionally light on chrome — focused single
 * destination for one task. The vendor portal link is the only
 * meaningful navigation; everything else stays in the modal.
 */
export function OperatorSetupModal({
  entry,
  initialClientId,
  open,
  onClose,
  onSaved,
}: {
  entry: DirectoryEntry;
  /** Pre-fill for the rotate case. Empty string for first-time setup. */
  initialClientId?: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState(initialClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Reset form state every time the modal opens — the same component
  // serves first-setup and rotate flows; stale values from a prior
  // open would confuse the user.
  useEffect(() => {
    if (open) {
      setClientId(initialClientId ?? "");
      setClientSecret("");
      setError(null);
      // Auto-focus the first empty field. Defer one tick so the modal
      // is mounted before we try to focus.
      setTimeout(() => firstFieldRef.current?.focus(), 0);
    }
  }, [open, initialClientId]);

  // Esc closes; this is a transient overlay, not navigation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const operatorSetup =
    entry.install.kind === "remote-oauth" ? entry.install.operatorSetup : undefined;
  if (!operatorSetup) return null;

  const isEdit = !!initialClientId;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) {
      setError("Both Client ID and Client Secret are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setupConnectorOperator(entry.id, clientId.trim(), clientSecret.trim());
      onSaved();
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
        aria-labelledby="operator-setup-title"
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md p-5"
      >
        <h2 id="operator-setup-title" className="text-base font-semibold">
          {isEdit ? `Edit ${entry.name} OAuth app` : `Set up ${entry.name}`}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          {isEdit
            ? "Rotate the OAuth client credentials for this workspace."
            : "Configure the OAuth app once per workspace. After setup, anyone in this workspace can connect their account."}
        </p>

        <ol className="mt-4 space-y-3 text-xs">
          <li className="flex items-start gap-2">
            <span className="font-semibold text-muted-foreground shrink-0">1.</span>
            <span>
              Create an OAuth app at{" "}
              <a
                href={operatorSetup.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline underline-offset-4"
              >
                {new URL(operatorSetup.portalUrl).hostname} ↗
              </a>
              .<span className="block text-muted-foreground mt-0.5">{operatorSetup.hint}</span>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-semibold text-muted-foreground shrink-0">2.</span>
            <span>Paste the credentials below and save.</span>
          </li>
        </ol>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium">Client ID</span>
            <input
              ref={firstFieldRef}
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className="mt-1 w-full text-sm font-mono px-2.5 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Client Secret</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              placeholder={isEdit ? "Paste new secret to rotate" : ""}
              className="mt-1 w-full text-sm font-mono px-2.5 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "Saving…" : isEdit ? "Save changes" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
