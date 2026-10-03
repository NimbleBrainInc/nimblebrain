import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "../../../components/ui/label";
import type { FieldStatus, FormStatus } from "../../../hooks/useAutosaveForm";
import { cn } from "../../../lib/utils";

/**
 * One field of a form that saves as it changes (`useAutosaveForm`): label,
 * status marker, control, then either the error or the hint.
 *
 * The marker is quiet text beside the label, not a box: a field says nothing
 * while it is clean, "Unsaved" while an edit is pending, "Saving…" while it is
 * written, and "Saved" for a moment after. Only a failure stays loud — the
 * message under the field, with Retry and Revert.
 */
export function AutosaveField({
  id,
  label,
  status,
  error,
  onRetry,
  onRevert,
  hint,
  children,
}: {
  id: string;
  label: string;
  status: FieldStatus;
  error: string | null;
  onRetry: () => void;
  onRevert: () => void;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <FieldStatusMarker status={status} />
      </div>
      {children}
      {status === "error" && error ? (
        <div id={errorId} role="alert" className="flex items-start justify-between gap-3">
          <p className="text-xs text-destructive">{error}</p>
          <div className="flex shrink-0 gap-2 text-xs">
            <button type="button" onClick={onRetry} className="font-medium hover:underline">
              Retry
            </button>
            <button
              type="button"
              onClick={onRevert}
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              Revert
            </button>
          </div>
        </div>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function FieldStatusMarker({ status }: { status: FieldStatus }) {
  return (
    <span
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1 text-xs transition-opacity duration-300 motion-reduce:transition-none",
        status === "clean" ? "opacity-0" : "opacity-100",
        status === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {status === "dirty" && "Unsaved"}
      {status === "saving" && (
        <>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Saving…
        </>
      )}
      {status === "saved" && (
        <>
          <Check className="h-3 w-3 text-success" aria-hidden="true" />
          Saved
        </>
      )}
      {status === "error" && (
        <>
          <AlertCircle className="h-3 w-3" aria-hidden="true" />
          Not saved
        </>
      )}
    </span>
  );
}

const FORM_STATUS_TEXT: Record<FormStatus, string> = {
  idle: "Changes save automatically",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "All changes saved",
  error: "Some changes were not saved",
};

/** The form-wide line under the page title: what the reader would otherwise look for a Save button to learn. */
export function AutosaveStatus({ status }: { status: FormStatus }) {
  return (
    <p
      aria-live="polite"
      className={cn(
        "text-xs whitespace-nowrap",
        status === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {FORM_STATUS_TEXT[status]}
    </p>
  );
}
