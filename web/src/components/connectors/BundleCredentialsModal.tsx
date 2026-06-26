import { useEffect, useRef, useState } from "react";
import {
  type BundleUserConfigField,
  clearBundleUserConfig,
  type InstalledConnector,
  setBundleUserConfig,
} from "../../api/client";

/**
 * Edit a stdio bundle's workspace `user_config` credentials, schema-
 * driven from the bundle's manifest. Mirrors `OperatorSetupModal`'s
 * shape so the Configure page presents a consistent credential-edit
 * idiom regardless of which lifecycle the user is touching.
 *
 * Security posture:
 *   - Existing values never leave the server. Each input starts empty;
 *     we render a "✓ configured" hint next to fields that already have
 *     a stored value so the user knows they don't have to re-enter
 *     untouched fields.
 *   - Only fields the user actually types into get sent. Empty string
 *     would be interpreted server-side as "clear this field," which
 *     would be wrong for the leave-untouched case.
 *   - Submitting routes through `manage_connectors.set_user_config`
 *     which is admin-gated; the modal trusts that gate and never tries
 *     to short-circuit the call client-side.
 */
export function BundleCredentialsModal({
  installed,
  open,
  onClose,
  onSaved,
}: {
  installed: InstalledConnector;
  open: boolean;
  onClose: () => void;
  onSaved: (populated: Record<string, boolean>) => void;
}) {
  const schema = installed.userConfig?.schema ?? {};
  const populated = installed.userConfig?.populated ?? {};
  const fieldKeys = Object.keys(schema);

  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const anyPopulated = fieldKeys.some((k) => populated[k] === true);

  // Reset every time the modal opens so a previous edit's typing
  // never leaks into a fresh edit on the same connector.
  useEffect(() => {
    if (open) {
      setValues({});
      setError(null);
      setConfirmingClear(false);
      setTimeout(() => firstFieldRef.current?.focus(), 0);
    }
  }, [open]);

  // Esc closes — same convention as OperatorSetupModal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;
  if (fieldKeys.length === 0) {
    // Defensive — page should not open the modal without a schema, but
    // returning null gracefully degrades if it does.
    return null;
  }

  const onClear = async () => {
    // Two-step inline confirm. `confirm()` is browser-suppressible
    // (Chrome's "block dialogs" toggle silently swallows it) and the
    // user has hit that no-op. First click arms; second click runs.
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setClearing(true);
    setError(null);
    try {
      const res = await clearBundleUserConfig(installed.serverName);
      onSaved(res.populated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setClearing(false);
      setConfirmingClear(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Only fields the user actually typed into get sent. An empty
    // string in `values` after an explicit clear-affordance is a v2
    // concern; v1's "Clear configuration" link nukes the whole file.
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v.length > 0) fields[k] = v;
    }
    if (Object.keys(fields).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setBundleUserConfig(installed.serverName, fields);
      // Credentials saved but bundle didn't respawn cleanly (e.g.,
      // required field still missing). Surface the underlying error
      // and keep the modal open — closing would hide the signal that
      // the bundle is now in a degraded state. Saved values stay
      // saved; the user can either fix the bad input or cancel.
      if (!res.respawn.ok) {
        setError(
          `Saved, but the bundle failed to restart: ${res.respawn.error ?? "unknown error"}`,
        );
        setBusy(false);
        return;
      }
      onSaved(res.populated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const connectorName = installed.catalog?.name ?? installed.serverName;

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
        aria-labelledby="bundle-credentials-title"
        className="bg-background border border-border rounded-sm shadow-xl w-full max-w-md p-5"
      >
        <h2 id="bundle-credentials-title" className="text-base font-semibold">
          Configure {connectorName}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Paste new values for fields you want to set or rotate. Leave a field empty to keep its
          existing value.
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          {fieldKeys.map((key, idx) => (
            <BundleField
              key={key}
              fieldKey={key}
              field={schema[key] as BundleUserConfigField}
              isPopulated={populated[key] === true}
              value={values[key] ?? ""}
              onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
              busy={busy}
              inputRef={idx === 0 ? firstFieldRef : undefined}
            />
          ))}
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center justify-between gap-3 pt-2">
            {/* Clear lives inside the modal — the user is already in
                context. Only renders when there's something to clear,
                so a fresh first-time setup doesn't tempt them with a
                no-op destructive link. */}
            {anyPopulated ? (
              <button
                type="button"
                onClick={onClear}
                disabled={busy || clearing}
                className={
                  confirmingClear
                    ? "text-xs font-medium text-destructive hover:underline underline-offset-4 disabled:opacity-60"
                    : "text-xs text-muted-foreground hover:text-destructive hover:underline underline-offset-4 disabled:opacity-60"
                }
              >
                {clearing
                  ? "Clearing…"
                  : confirmingClear
                    ? "Click again to clear all credentials"
                    : "Clear configuration"}
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy || clearing}
                className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || clearing}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Render one schema-driven field. Strings render as text or password
 * depending on the manifest's `sensitive` flag. Anything else gets a
 * console warning + disabled stub so a future bundle that declares an
 * unknown type doesn't silently lose its field; the Set up CLI path
 * still works as a fallback.
 */
function BundleField({
  fieldKey,
  field,
  isPopulated,
  value,
  onChange,
  busy,
  inputRef,
}: {
  fieldKey: string;
  field: BundleUserConfigField;
  isPopulated: boolean;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  if (field.type !== "string") {
    if (typeof console !== "undefined") {
      console.warn(
        `[BundleCredentialsModal] field "${fieldKey}" has unsupported type "${field.type}"; ` +
          "render disabled. Edit via the CLI for now.",
      );
    }
    return (
      <div className="block">
        <span className="text-xs font-medium">{field.title ?? fieldKey}</span>
        <p className="text-xs text-muted-foreground mt-0.5">
          Field type "{field.type}" is not editable here yet — use the CLI.
        </p>
      </div>
    );
  }

  const inputType = field.sensitive ? "password" : "text";
  const label = field.title ?? fieldKey;
  return (
    <label className="block">
      <span className="text-xs font-medium flex items-center gap-2">
        {label}
        {field.required && <span className="text-destructive">*</span>}
        {isPopulated && (
          <span className="text-3xs font-normal text-muted-foreground">✓ configured</span>
        )}
      </span>
      {field.description && (
        <span className="block text-2xs text-muted-foreground mt-0.5">{field.description}</span>
      )}
      <input
        ref={inputRef}
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        // Password-manager opt-outs. These fields are credential
        // *entry* points (we're storing values into the app, not
        // logging into a website), so password managers shouldn't
        // offer autofill or warn about pasting. The two attributes
        // cover 1Password and LastPass / Dashlane respectively;
        // browsers ignore unknown data-* attributes.
        data-1p-ignore="true"
        data-lpignore="true"
        spellCheck={false}
        disabled={busy}
        placeholder={isPopulated ? "Leave blank to keep existing value" : ""}
        className="mt-1 w-full text-sm font-mono px-2.5 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      />
    </label>
  );
}
