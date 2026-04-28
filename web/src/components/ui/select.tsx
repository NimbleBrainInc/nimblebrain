import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Styled native `<select>` — visual parity with `Input`. Replaces the
 * `selectClass` string copy-pasted across four settings tabs.
 *
 * Native select rather than a custom popover for two reasons: (1) it
 * inherits OS keyboard / a11y behavior for free, (2) settings selects
 * are short, low-frequency, and don't need search. The `TimezoneSelect`
 * primitive is the escape hatch for searchable lists.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
