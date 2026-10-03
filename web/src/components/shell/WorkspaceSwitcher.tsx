// ---------------------------------------------------------------------------
// WorkspaceSwitcher — the sidebar's "which workspace am I in" control.
//
// The trigger names the focused workspace; the nav below it shows only that
// workspace's views, because the runtime walls every session to exactly one
// workspace. Opening it lists every workspace alphabetically behind a filter
// box (a combobox: type to narrow, ↑ ↓ to move, Enter to switch), with the
// focused one checked. The order never moves the focused workspace: positions
// stay where a member learned them, and the trigger already names it. Nothing
// is highlighted until the member types or presses ↓, so the check is the only
// mark that reads as "selected"; the focused row scrolls into view on open.
// Its footer holds the two workspace-level actions:
// the focused workspace's settings, and creating a new one.
//
// A dot marks a workspace with unread notifications, on its row and, when it
// is a workspace other than this one, on the trigger: the trigger is the way
// there, so it is where the dot pulls.
//
// Switching mirrors the api/client setter's equality guard — re-picking the
// focused workspace never calls setActiveWorkspace — and always lands on the
// workspace's overview, so a view the new workspace lacks can't strand you.
// ---------------------------------------------------------------------------

import { Popover } from "@base-ui/react/popover";
import { Check, ChevronsUpDown, Plus, Search, Settings } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { useWorkspaceUnread } from "../../context/WorkspaceUnreadContext";
import { cn } from "../../lib/utils";
import { getWorkspaceAvatar } from "../../lib/workspace-avatar";
import { orderWorkspacesForSidebar } from "../../lib/workspace-order";
import { toSlug } from "../../lib/workspace-slug";
import { Tooltip } from "../ui/tooltip";
import { UnreadDot } from "./UnreadDot";

export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const wsCtx = useWorkspaceContext();
  const navigate = useNavigate();
  const focused = wsCtx.activeWorkspace;
  const { unreadFor } = useWorkspaceUnread();
  const elsewhere = wsCtx.workspaces.some((ws) => ws.id !== focused?.id && unreadFor(ws.id) > 0);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const ordered = useMemo(() => orderWorkspacesForSidebar(wsCtx.workspaces), [wsCtx.workspaces]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ordered.filter((ws) => ws.name.toLowerCase().includes(q)) : ordered;
  }, [ordered, query]);
  // -1: nothing highlighted (the list as opened, before typing or ↓).
  const active = Math.min(highlight, matches.length - 1);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      setHighlight(-1);
    }
  }, []);

  const go = useCallback(
    (path: string) => {
      setOpen(false);
      navigate(path);
    },
    [navigate],
  );

  const select = useCallback(
    (ws: WorkspaceInfo) => {
      if (wsCtx.activeWorkspace?.id !== ws.id) wsCtx.setActiveWorkspace(ws);
      go(`/w/${toSlug(ws.id)}/`);
    },
    [wsCtx, go],
  );

  // Keep the highlighted option in view as the arrow keys move past the fold.
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });

  // On open, show where the member is: the focused workspace may sit below the fold.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per open; the list is read from the DOM
  useEffect(() => {
    if (!open) return;
    const index = matches.findIndex((ws) => ws.id === focused?.id);
    if (index >= 0) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(Math.min(active + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const ws = matches[active];
      if (ws) select(ws);
    }
  }

  const label = focused?.name ?? "Choose a workspace";
  const triggerLabel = `Workspace: ${label}. Switch workspace${
    elsewhere ? ". Another workspace has unread notifications" : ""
  }`;
  const trigger = collapsed ? (
    <Popover.Trigger
      aria-label={triggerLabel}
      data-testid="workspace-switcher-trigger"
      className="relative mx-auto my-1 flex size-10 items-center justify-center rounded-md transition-colors hover:bg-sidebar-foreground/10 data-[popup-open]:bg-sidebar-foreground/10"
    >
      {focused && <WorkspaceGlyph workspace={focused} size="lg" />}
      {elsewhere && <UnreadDot className="absolute top-1 right-1 ring-2 ring-sidebar" />}
    </Popover.Trigger>
  ) : (
    <Popover.Trigger
      aria-label={triggerLabel}
      data-testid="workspace-switcher-trigger"
      className="mx-2 flex h-9 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md border border-sidebar-border bg-background px-2 text-left transition-colors hover:border-sidebar-foreground/20 data-[popup-open]:border-sidebar-foreground/20"
    >
      {focused && <WorkspaceGlyph workspace={focused} />}
      <span className="flex-1 truncate text-sm font-semibold text-foreground">{label}</span>
      {elsewhere && <UnreadDot />}
      <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0" />
    </Popover.Trigger>
  );

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      {collapsed ? (
        <Tooltip label={label} side="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Popover.Portal>
        <Popover.Positioner
          side={collapsed ? "right" : "bottom"}
          align="start"
          sideOffset={collapsed ? 8 : 4}
          className="z-50"
        >
          <Popover.Popup
            initialFocus={inputRef}
            aria-label="Switch workspace"
            data-testid="workspace-switcher"
            className="ws-dropdown-enter w-[max(var(--anchor-width),17rem)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg outline-none"
          >
            <div className="flex h-10 items-center gap-2 border-b border-border px-3">
              <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label="Find a workspace"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                autoComplete="off"
                spellCheck={false}
                placeholder="Find a workspace…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={handleKeyDown}
                data-testid="workspace-switcher-input"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div
              id={listId}
              role="listbox"
              aria-label="Workspaces"
              className="flex max-h-80 flex-col gap-px overflow-y-auto p-1"
            >
              {matches.map((ws, i) => {
                const current = ws.id === focused?.id;
                const unread = unreadFor(ws.id) > 0;
                return (
                  <button
                    key={ws.id}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={current}
                    data-highlighted={i === active ? "" : undefined}
                    data-testid="workspace-switcher-option"
                    data-workspace-id={ws.id}
                    onClick={() => select(ws)}
                    onMouseMove={() => i !== active && setHighlight(i)}
                    className="flex min-h-8 items-center gap-2.5 rounded-sm px-2 text-left text-sm text-foreground data-[highlighted]:bg-foreground/10"
                  >
                    <WorkspaceGlyph workspace={ws} />
                    <span className="flex-1 truncate">
                      {ws.name}
                      {unread && <span className="sr-only">, unread notifications</span>}
                    </span>
                    {unread && <UnreadDot />}
                    {current && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
                  </button>
                );
              })}
              {matches.length === 0 && (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  No workspace matches “{query.trim()}”
                </div>
              )}
            </div>

            <div className="flex flex-col gap-px border-t border-border p-1">
              {focused && (
                <FooterAction
                  icon={Settings}
                  label={`${focused.name} settings`}
                  testId="workspace-switcher-settings"
                  onClick={() => go(`/w/${toSlug(focused.id)}/settings`)}
                />
              )}
              <FooterAction
                icon={Plus}
                label="New workspace"
                testId="workspace-switcher-new"
                onClick={() => go("/org/workspaces")}
              />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FooterAction({
  icon: Icon,
  label,
  testId,
  onClick,
}: {
  icon: typeof Settings;
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex min-h-8 items-center gap-2.5 rounded-sm px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// The workspace's deterministic letter + color avatar.
function WorkspaceGlyph({
  workspace,
  size = "md",
}: {
  workspace: WorkspaceInfo;
  size?: "md" | "lg";
}) {
  const avatar = getWorkspaceAvatar(workspace);
  return (
    <span
      aria-hidden="true"
      data-testid="workspace-avatar"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm font-semibold text-white",
        size === "lg" ? "size-6 text-xs" : "size-[18px] text-3xs",
      )}
      style={{ backgroundColor: avatar.color }}
    >
      {avatar.letter}
    </span>
  );
}
