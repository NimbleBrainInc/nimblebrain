// ---------------------------------------------------------------------------
// Switch — an on/off setting that takes effect when flipped.
//
// The control shows the state and changes it, so a row needs no "Enable" /
// "Disable" word beside it. Use it for a setting that saves on change; a choice
// that waits for a Save button is a checkbox.
// ---------------------------------------------------------------------------

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "../../lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-foreground/10 p-0.5 transition-colors outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50 data-[checked]:bg-primary",
        "disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block size-3.5 rounded-full bg-background shadow-sm transition-transform data-[checked]:translate-x-3.5 motion-reduce:transition-none" />
    </BaseSwitch.Root>
  );
}
