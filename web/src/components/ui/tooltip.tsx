// ---------------------------------------------------------------------------
// Tooltip — the label for an icon-only control.
//
// An inverted pill (foreground fill, background text) beside the trigger, with
// an optional shortcut chip. It names a control that has no visible text, so
// put one on every icon-only button; a control with a visible label needs
// none. The trigger still carries its own `aria-label`: the tooltip is for
// sighted pointer and keyboard users, not the accessible name.
//
// Wrap a region in `TooltipProvider` so moving across neighboring triggers
// (a rail of icons) shows each label at once after the first delay.
// ---------------------------------------------------------------------------

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/** Shared open delay for the tooltips inside it. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={400}>{children}</BaseTooltip.Provider>;
}

interface TooltipProps {
  label: string;
  /** A keyboard shortcut shown as a chip after the label, e.g. "⌘K". */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** The trigger element. It must accept a ref and spread props. */
  children: ReactElement;
}

export function Tooltip({ label, shortcut, side = "right", children }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={8} className="z-50">
          <BaseTooltip.Popup
            data-testid="tooltip"
            className="flex items-center gap-2 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-md"
          >
            {label}
            {shortcut && (
              <kbd className="-mr-1 rounded-xs bg-background/20 px-1 py-0.5 font-sans text-2xs">
                {shortcut}
              </kbd>
            )}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
