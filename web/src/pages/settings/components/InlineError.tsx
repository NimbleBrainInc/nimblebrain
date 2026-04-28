import type { ReactNode } from "react";

/**
 * Inline error banner — single style for the 10+ ad-hoc copies of
 * `<p className="text-sm text-destructive">{msg}</p>` scattered through
 * the settings tabs.
 *
 * `action` is the optional retry / dismiss slot, rendered to the right.
 */
export function InlineError({
  message,
  action,
  role = "alert",
}: {
  message: string;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
      role={role}
    >
      <p className="text-sm text-destructive">{message}</p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
