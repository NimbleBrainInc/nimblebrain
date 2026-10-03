import { cn } from "../../lib/utils";

/**
 * The one mark for "something here is unread": the bell, an inbox row, a
 * workspace in the switcher or on the home grid. Decorative; the control it
 * sits on says the same thing in its accessible name.
 */
export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="unread-dot"
      className={cn("size-2 shrink-0 rounded-full bg-primary", className)}
    />
  );
}
