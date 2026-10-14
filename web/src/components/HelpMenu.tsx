// ---------------------------------------------------------------------------
// HelpMenu — the sidebar's way to the documentation and the keyboard
// shortcuts.
//
// It is the nav's last row, pinned below the scrolling views and above the
// divider that sets off the account: help is the same on every page, so it
// sits in the sidebar and not in the top bar, whose controls belong to the
// workspace. On the icon rail it is an icon with a tooltip and opens to the
// right; expanded, it is a labelled row and opens upward over the nav.
// ---------------------------------------------------------------------------

import { Menu } from "@base-ui/react/menu";
import { BookOpen, CircleHelp, ExternalLink, Keyboard } from "lucide-react";
import { memo, useState } from "react";
import { DOCS_URL } from "../lib/docs";
import { cn } from "../lib/utils";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { Tooltip } from "./ui/tooltip";

const itemClass =
  "flex w-full cursor-default items-center gap-2.5 px-3 py-2 text-sm outline-none data-[highlighted]:bg-foreground/10";

export const HelpMenu = memo(function HelpMenu({ collapsed }: { collapsed: boolean }) {
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Sized and aligned like a nav row (`WorkspaceNav`'s rowClass), so it reads
  // as the nav's last item rather than part of the account below.
  const trigger = (
    <Menu.Trigger
      aria-label="Help"
      data-testid="help-menu-trigger"
      className={cn(
        "flex items-center rounded-sm text-sm transition-colors",
        "hover:bg-sidebar-foreground/5 hover:text-foreground data-[popup-open]:bg-sidebar-foreground/5",
        collapsed ? "size-9 justify-center" : "min-h-8 w-full gap-2.5 px-2",
      )}
    >
      <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
      {!collapsed && <span className="flex-1 truncate text-left">Help</span>}
    </Menu.Trigger>
  );

  return (
    <div className={cn("shrink-0 pb-2", collapsed ? "flex justify-center px-3" : "px-2")}>
      <Menu.Root>
        {collapsed ? (
          <Tooltip label="Help" side="right">
            {trigger}
          </Tooltip>
        ) : (
          trigger
        )}
        <Menu.Portal>
          <Menu.Positioner
            side={collapsed ? "right" : "top"}
            align={collapsed ? "end" : "start"}
            sideOffset={4}
            className="z-50"
          >
            <Menu.Popup
              data-testid="help-menu"
              className="min-w-52 rounded-sm border bg-popover py-1 text-popover-foreground shadow-md outline-none"
            >
              <Menu.LinkItem
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={itemClass}
              >
                <BookOpen aria-hidden="true" className="size-4" />
                <span className="flex-1">Documentation</span>
                <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </Menu.LinkItem>
              <Menu.Item className={itemClass} onClick={() => setShowShortcuts(true)}>
                <Keyboard aria-hidden="true" className="size-4" />
                <span className="flex-1">Keyboard shortcuts</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <KeyboardShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
});
