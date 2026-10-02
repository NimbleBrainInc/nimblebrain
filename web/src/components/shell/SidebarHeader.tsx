// ---------------------------------------------------------------------------
// SidebarHeader — the sidebar's top row: the logo, search, and the sidebar
// toggle.
//
// Expanded: the full logo (home) on the left; search (opens the command
// palette) and close-sidebar on the right.
//
// Collapsed (icon rail): the logo IS the open-sidebar control. At rest it
// shows the mark; on hover or keyboard focus it turns into the open-sidebar
// icon, so the rail spends no row on a separate expand button. Search sits
// under it.
// ---------------------------------------------------------------------------

import { PanelLeft, PanelLeftOpen, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { usePalette } from "../../context/PaletteContext";
import { useSidebar } from "../../context/SidebarContext";
import { ariaKeyShortcuts, SHORTCUTS } from "../../lib/shortcuts";
import { Logo } from "../Logo";
import { Tooltip } from "../ui/tooltip";

const iconButton =
  "flex size-8 items-center justify-center rounded-md transition-colors hover:bg-sidebar-foreground/10 hover:text-foreground";

export function SidebarHeader({ collapsed = false }: { collapsed?: boolean }) {
  const { toggle } = useSidebar();
  const { openPalette } = usePalette();

  const search = (
    <Tooltip label="Search" shortcut={SHORTCUTS.search} side={collapsed ? "right" : "bottom"}>
      <button
        type="button"
        onClick={() => openPalette()}
        aria-label="Search"
        aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.search)}
        data-testid="sidebar-search"
        className={iconButton}
      >
        <Search aria-hidden="true" className="size-4" />
      </button>
    </Tooltip>
  );

  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-1 pt-3 pb-1">
        <Tooltip label="Open sidebar" shortcut={SHORTCUTS.sidebar} side="right">
          <button
            type="button"
            onClick={toggle}
            aria-label="Open sidebar"
            aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.sidebar)}
            data-testid="sidebar-toggle"
            className="group/logo mb-1 flex size-10 items-center justify-center rounded-md transition-colors hover:bg-sidebar-foreground/10 hover:text-foreground focus-visible:bg-sidebar-foreground/10"
          >
            <Logo
              variant="icon"
              height={28}
              className="group-hover/logo:hidden group-focus-visible/logo:hidden"
            />
            <PanelLeftOpen
              aria-hidden="true"
              className="hidden size-[18px] group-hover/logo:block group-focus-visible/logo:block"
            />
          </button>
        </Tooltip>
        {search}
      </div>
    );
  }

  return (
    <div className="flex h-14 shrink-0 items-center justify-between pr-2.5 pl-3">
      <Link to="/" aria-label="NimbleBrain home" className="flex min-w-0 rounded-md">
        <Logo variant="full" height={24} />
      </Link>
      <div className="flex items-center gap-0.5">
        {search}
        <Tooltip label="Close sidebar" shortcut={SHORTCUTS.sidebar}>
          <button
            type="button"
            onClick={toggle}
            aria-label="Close sidebar"
            aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.sidebar)}
            data-testid="sidebar-toggle"
            className={iconButton}
          >
            <PanelLeft aria-hidden="true" className="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
