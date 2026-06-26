// ---------------------------------------------------------------------------
// SidebarSearch — the command palette trigger.
//
// Renders the input-shaped affordance from the mockup (search glyph + prompt +
// ⌘P chip) as a button that opens the palette. The ⌘P keyboard shortcut itself
// lives in PaletteProvider (so it works even when the sidebar is collapsed or
// hidden) — this is purely the click target.
// ---------------------------------------------------------------------------

import { Search } from "lucide-react";
import { usePalette } from "../../context/PaletteContext";

export function SidebarSearch() {
  const { openPalette } = usePalette();

  return (
    <div className="mx-2 mt-1 mb-2" data-testid="sidebar-search">
      <button
        type="button"
        onClick={() => openPalette()}
        aria-label="Open command palette"
        aria-keyshortcuts="Meta+P Control+P"
        className="w-full h-8 flex items-center gap-2.5 pl-2.5 pr-1.5 rounded-sm text-sm bg-sidebar-foreground/5 border border-transparent hover:bg-sidebar-foreground/10 hover:border-sidebar-foreground/20 transition-colors text-left"
      >
        <Search
          aria-hidden="true"
          className="text-sidebar-foreground/50 shrink-0"
          style={{ width: 14, height: 14 }}
        />
        <span className="flex-1 truncate text-sidebar-foreground/50">Search or run a command</span>
        <kbd className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-3xs font-medium bg-sidebar-foreground/10 text-sidebar-foreground/60 border border-sidebar-border">
          ⌘P
        </kbd>
      </button>
    </div>
  );
}
