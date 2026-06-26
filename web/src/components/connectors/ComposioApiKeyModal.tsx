import { useEffect, useRef, useState } from "react";
import { type ComposioField, connectComposioApiKey } from "../../api/client";

/**
 * Field-collection modal for a non-redirect (API-key) Composio connector.
 * The sibling of {@link OperatorSetupModal}: instead of an OAuth round-trip,
 * the user pastes the connector's declared `fields` (e.g. a PostHog personal
 * API key + region), which are handed to Composio at connect time and never
 * persisted by the platform. Used for both first connect and reconnect/rotation
 * (the rotation case is ws_admin gated server-side; the error surfaces inline).
 *
 * Form shape is driven entirely by `fields` so any API-key toolkit reuses it —
 * the component knows nothing PostHog-specific.
 */
export function ComposioApiKeyModal({
  catalogId,
  connectorName,
  fields,
  open,
  onClose,
  onConnected,
}: {
  catalogId: string;
  connectorName: string;
  fields: ComposioField[];
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Reset on open so a reconnect/rotation never shows stale values.
  useEffect(() => {
    if (open) {
      setValues({});
      setError(null);
      setBusy(false);
      setTimeout(() => firstFieldRef.current?.focus(), 0);
    }
  }, [open]);

  // Esc closes; transient overlay, not navigation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  // Required unless explicitly opted out — mirrors the server's
  // `required !== false` default-deny in connect_api_key.
  const isRequired = (f: ComposioField) => f.required !== false;

  const submit = async () => {
    if (busy) return;
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.key] ?? "").trim();
      if (!v) {
        if (isRequired(f)) {
          setError(`${f.title} is required.`);
          return;
        }
        continue;
      }
      payload[f.key] = v;
    }
    setBusy(true);
    setError(null);
    try {
      await connectComposioApiKey(catalogId, payload);
      onConnected();
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
        aria-labelledby="composio-apikey-title"
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md p-5"
      >
        <h2 id="composio-apikey-title" className="text-base font-semibold">
          Connect {connectorName}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Enter your credentials below. They're sent to the connector provider and never stored by
          the platform.
        </p>

        {/* Not a <form>: validation lives in JS (`submit`) and the primary
            button drives it via onClick. Enter-to-submit is preserved by the
            per-input keydown handler. (Native form submission triggers the
            browser's checkValidity pass, which we don't use.) */}
        <div className="mt-4 space-y-3">
          {fields.map((f, idx) => (
            <label key={f.key} className="block">
              <span className="text-xs font-medium">
                {f.title}
                {!isRequired(f) && <span className="text-muted-foreground"> (optional)</span>}
              </span>
              <input
                ref={idx === 0 ? firstFieldRef : undefined}
                type={f.sensitive ? "password" : "text"}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                spellCheck={false}
                disabled={busy}
                placeholder={f.placeholder}
                className="mt-1 w-full text-sm font-mono px-2.5 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              />
              {f.description && (
                <span className="block text-2xs text-muted-foreground mt-1">{f.description}</span>
              )}
            </label>
          ))}
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
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
