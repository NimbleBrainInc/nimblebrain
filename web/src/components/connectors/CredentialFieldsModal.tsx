import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** One value the dialog collects. `key` is opaque to the modal — it keys the submitted map. */
export interface CredentialField {
  key: string;
  label: string;
  /** One line under the input. */
  description?: string;
  /** Render a password input. */
  sensitive?: boolean;
  /** Required unless explicitly false — the same default-deny the server applies. */
  required?: boolean;
  placeholder?: string;
}

const isRequired = (f: CredentialField) => f.required !== false;

/**
 * Trim `values` against `fields`, returning the submit payload or the first
 * missing-required-field error. Exported for the same reason the collection
 * lives here at all: the rule is one rule, and both callers get it.
 */
export function collectFieldValues(
  fields: CredentialField[],
  values: Record<string, string>,
): { payload: Record<string, string> } | { error: string } {
  const payload: Record<string, string> = {};
  for (const f of fields) {
    const v = (values[f.key] ?? "").trim();
    if (!v) {
      if (isRequired(f)) return { error: `${f.label} is required.` };
      continue;
    }
    payload[f.key] = v;
  }
  return { payload };
}

/**
 * A modal that collects declared fields and hands them to a submit handler.
 *
 * Two credential paths render it: an API-key connector's Composio fields, and
 * the workspace secrets a `secretHeaders` entry declares. They differ only in
 * what the fields are and where the values go, so they share the form, the
 * required-field rule, the busy/error handling, and the traits that keep a
 * secret out of places it should not be — no value in the DOM after submit, no
 * value logged, no password manager capture, `autoComplete="off"`.
 *
 * Values live in this component's state and go to `onSubmit` and nowhere else.
 * The component never reads a value back from a server and has no affordance
 * for revealing a stored one.
 */
export function CredentialFieldsModal({
  titleId,
  title,
  description,
  fields,
  submitLabel,
  busyLabel,
  open,
  onClose,
  onSubmit,
}: {
  /** Unique id for the dialog's `aria-labelledby`. */
  titleId: string;
  title: string;
  description: string;
  fields: CredentialField[];
  submitLabel: string;
  busyLabel: string;
  open: boolean;
  onClose: () => void;
  /** Resolve to close; throw to show the error and leave the dialog open. */
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Reset on open so a rotation never shows the previous open's values.
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

  const submit = async () => {
    if (busy) return;
    const result = collectFieldValues(fields, values);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(result.payload);
      // Drop the collected values on success. The caller unmounts us, but a
      // handler that navigates instead would otherwise leave them in state.
      setValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is a mouse convenience; keyboard users dismiss via ESC
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
        aria-labelledby={titleId}
        className="bg-background border border-border rounded-sm shadow-xl w-full max-w-md p-5"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>

        {/* Not a <form>: validation lives in JS (`submit`) and the primary
            button drives it via onClick. Enter-to-submit is preserved by the
            per-input keydown handler. (Native form submission triggers the
            browser's checkValidity pass, which we don't use.) */}
        <div className="mt-4 space-y-3">
          {fields.map((f, idx) => (
            <label key={f.key} className="block" htmlFor={`${titleId}-${f.key}`}>
              <span className="text-xs font-medium">
                {f.label}
                {!isRequired(f) && <span className="text-muted-foreground"> (optional)</span>}
              </span>
              <Input
                id={`${titleId}-${f.key}`}
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
                className="mt-1 font-mono"
              />
              {f.description && (
                <span className="block text-2xs text-muted-foreground mt-1">{f.description}</span>
              )}
            </label>
          ))}
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void submit()} disabled={busy}>
              {busy ? busyLabel : submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
