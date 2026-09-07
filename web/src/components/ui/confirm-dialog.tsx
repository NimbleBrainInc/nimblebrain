import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";

/**
 * Ask before doing something, and show what "it" is.
 *
 * A destructive action that cannot say what it will take with it is an action
 * nobody consented to, which is why `children` is arbitrary: the caller renders
 * what the action does, and any per-action control it needs, in the body.
 *
 * This returns approve or deny and nothing else. A choice inside the body —
 * a checkbox, a mode — belongs to the caller: it owns the state, renders the
 * control in `children`, and reads it in its own `onConfirm`. A primitive that
 * returned a payload would be a form, and it would grow one field per caller.
 *
 * Built on `@base-ui/react/dialog` because focus trapping, focus restore,
 * escape, backdrop dismissal and the `aria-labelledby` / `aria-describedby`
 * wiring are the parts every hand-rolled modal gets subtly differently. They
 * are asserted once, against this component.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  pendingLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line under the title. Becomes the dialog's accessible description. */
  description?: string;
  /** What the action will do, and any control that shapes it. */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirm's label while `onConfirm` is in flight. Defaults to `confirmLabel`. */
  pendingLabel?: string;
  /** Render confirm in the destructive variant. */
  destructive?: boolean;
  /**
   * Resolve to close. Throw to leave the dialog open with the error shown —
   * the caller's failure is reported where the caller can act on it, rather
   * than behind a dialog that has already dismissed itself.
   */
  onConfirm: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // A reopen starts clean: an error from the previous open describes a run the
  // user has already dismissed.
  useEffect(() => {
    if (open) {
      setError(null);
      setPending(false);
    }
  }, [open]);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      // Left to the caller to close. A confirm that navigates away has nothing
      // to close, and one that stays wants the dialog gone on its own terms.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      // Every dismissal path — escape, backdrop, cancel — lands here and denies.
      // While the action is in flight none of them do: closing over a running
      // confirm would leave its outcome with nowhere to be reported.
      onOpenChange={(next) => {
        if (pending && !next) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          // Confirm rather than the first tabbable element, so the dialog opens
          // on the decision it is asking about.
          initialFocus={confirmRef}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-background p-5 shadow-xl transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
        >
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-1 text-xs text-muted-foreground">
              {description}
            </Dialog.Description>
          )}

          {children && <div className="mt-4 space-y-3 text-xs">{children}</div>}

          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

          <div className="mt-5 flex items-center justify-end gap-2">
            <Dialog.Close
              disabled={pending}
              render={<Button type="button" variant="outline" size="sm" />}
            >
              {cancelLabel}
            </Dialog.Close>
            <Button
              ref={confirmRef}
              type="button"
              size="sm"
              variant={destructive ? "destructive" : "default"}
              disabled={pending}
              onClick={() => void confirm()}
            >
              {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
