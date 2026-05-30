// ---------------------------------------------------------------------------
// CommandRow — one result row in the palette.
//
// Renders the leading glyph by CommandIcon kind (letter avatar / lucide /
// brand icon via ConnectorIcon), the title + optional mono subtitle, and a
// right-aligned meta tag. Selection is driven by the parent (single flat index
// across groups), surfaced here via `selected` for the accent background and
// `aria-selected`.
// ---------------------------------------------------------------------------

import { memo } from "react";
import { resolveIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import type { CommandIcon, CommandItem } from "./types";

function RowIcon({ icon }: { icon?: CommandIcon }) {
  if (!icon) return null;
  if (icon.kind === "letter") {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center rounded-md text-white text-[11px] font-semibold"
        style={{ width: 24, height: 24, backgroundColor: icon.color }}
      >
        {icon.letter}
      </span>
    );
  }
  if (icon.kind === "lucide") {
    const Icon = resolveIcon(icon.name);
    return (
      <span
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center rounded-md bg-muted text-muted-foreground"
        style={{ width: 24, height: 24 }}
      >
        <Icon style={{ width: 14, height: 14 }} />
      </span>
    );
  }
  // brand
  return (
    <ConnectorIcon
      name={icon.fallbackLetter}
      iconUrl={icon.url}
      className="h-6 w-6 rounded-md text-[11px]"
    />
  );
}

export const CommandRow = memo(function CommandRow({
  item,
  selected,
  onSelect,
  onHover,
}: {
  item: CommandItem;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      id={`palette-opt-${item.id}`}
      data-testid="palette-row"
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        "w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50",
      )}
    >
      <RowIcon icon={item.icon} />
      <span className="flex-1 min-w-0 leading-tight">
        <span className="block text-sm truncate">{item.title}</span>
        {item.subtitle && (
          <span className="block text-[11px] text-muted-foreground font-mono truncate">
            {item.subtitle}
          </span>
        )}
      </span>
      {item.meta && (
        <span className="shrink-0 text-[10.5px] font-mono text-muted-foreground">{item.meta}</span>
      )}
    </button>
  );
});
