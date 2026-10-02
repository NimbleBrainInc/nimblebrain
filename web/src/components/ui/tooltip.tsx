// ---------------------------------------------------------------------------
// Tooltip — the label for an icon-only control.
//
// A dark pill (the `tooltip` tokens) beside the trigger, with the control's
// keyboard shortcut as a chip when it has one. The rule for when to use it
// lives in `web/DESIGN.md` § Tooltips. The trigger keeps its own `aria-label`:
// the tooltip is for sighted pointer and keyboard users, not the accessible
// name.
//
// Wrap a region in `TooltipProvider` so moving across neighboring triggers
// (a rail of icons, a toolbar) shows each label at once after the first delay.
// ---------------------------------------------------------------------------

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { type Shortcut, shortcutLabel } from "../../lib/shortcuts";
import { cn } from "../../lib/utils";

/** Shared open delay for the tooltips inside it. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={400}>{children}</BaseTooltip.Provider>;
}

interface TooltipProps {
  /** What the control does, in a few words: "Search", "Close sidebar". */
  label: string;
  /** The control's chord from `lib/shortcuts`, shown as a chip after the label. */
  shortcut?: Shortcut;
  /** Which side of the trigger. Point it away from the nearest screen edge. */
  side?: "top" | "right" | "bottom" | "left";
  /** The trigger element. It must accept a ref and spread props. */
  children: ReactElement;
}

export function Tooltip({ label, shortcut, side = "bottom", children }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup
            data-testid="tooltip"
            className={cn(
              "flex items-center gap-2 rounded-full bg-tooltip py-1.5 text-sm font-medium text-tooltip-foreground shadow-lg",
              "transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
              // The chip sits closer to the pill's edge than the label does.
              shortcut ? "pr-1.5 pl-3" : "px-3",
            )}
          >
            {label}
            {shortcut && (
              <kbd className="rounded-full bg-tooltip-foreground/20 px-2 py-0.5 font-sans text-xs font-medium tracking-wide">
                {shortcutLabel(shortcut)}
              </kbd>
            )}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
