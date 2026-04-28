import type { ReactNode } from "react";

/**
 * Dashed-border centered placeholder. Lifted from five copies in the
 * settings tabs that all rendered the same `rounded-md border border-dashed
 * p-8 text-center` shape with slightly different copy.
 *
 * `action` is optional — for empty list states a "Create the first X"
 * button often belongs here so the user has somewhere to click instead of
 * an explanatory dead-end.
 */
export function EmptyState({ message, action }: { message: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}
