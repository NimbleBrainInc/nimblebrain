import { Check, ChevronDown, Lock, Settings, Users } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { cn } from "../lib/utils";
import { toSlug } from "../lib/workspace-slug";

interface WorkspaceSelectorProps {
  collapsed: boolean;
}

// ---------------------------------------------------------------------------
// Avatar color palette — 12 carefully chosen hues that work on both
// light and dark backgrounds. Each pair is [bg, text].
// ---------------------------------------------------------------------------

const AVATAR_PALETTE: [string, string][] = [
  ["#E8573F", "#fff"], // vermilion
  ["#D97706", "#fff"], // amber
  ["#059669", "#fff"], // emerald
  ["#0284C7", "#fff"], // sky
  ["#7C3AED", "#fff"], // violet
  ["#DB2777", "#fff"], // pink
  ["#0D9488", "#fff"], // teal
  ["#9333EA", "#fff"], // purple
  ["#2563EB", "#fff"], // blue
  ["#C2410C", "#fff"], // orange
  ["#4F46E5", "#fff"], // indigo
  ["#0891B2", "#fff"], // cyan
];

/** Deterministic hash → palette index from workspace name. */
function colorIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % AVATAR_PALETTE.length;
}

/** Derive 2-letter initials from a workspace name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Avatar component
// ---------------------------------------------------------------------------

function WorkspaceAvatar({
  name,
  size = "md",
  variant = "muted",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
  variant?: "muted" | "colored";
}) {
  const dims = {
    sm: "w-5 h-5 text-[10px] rounded",
    md: "w-7 h-7 text-xs rounded-md",
    lg: "w-9 h-9 text-sm rounded-lg",
  };

  if (variant === "colored") {
    const idx = colorIndex(name);
    const [bg, fg] = AVATAR_PALETTE[idx];
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center font-semibold shrink-0 select-none",
          dims[size],
        )}
        style={{ backgroundColor: bg, color: fg }}
      >
        {initials(name)}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center font-semibold shrink-0 select-none",
        "bg-sidebar-foreground/10 text-sidebar-foreground",
        dims[size],
      )}
    >
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const WorkspaceSelector = memo(function WorkspaceSelector({
  collapsed,
}: WorkspaceSelectorProps) {
  const { workspaces, activeWorkspace, setActiveWorkspace, loading } = useWorkspaceContext();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const canSwitch = workspaces.length > 1;
  // Always allow opening the dropdown — even with one workspace, the
  // "Settings" link inside is useful.
  const canOpen = true;

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const handleSelect = useCallback(
    (ws: (typeof workspaces)[number]) => {
      setActiveWorkspace(ws);
      setOpen(false);
      navigate(`/w/${toSlug(ws.id)}/`);
    },
    [setActiveWorkspace, navigate],
  );

  const sortedWorkspaces = useMemo(() => {
    if (!activeWorkspace) return workspaces;
    return [...workspaces].sort((a, b) => {
      if (a.id === activeWorkspace.id) return -1;
      if (b.id === activeWorkspace.id) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [workspaces, activeWorkspace]);

  // --- Loading skeleton ---
  if (loading || !activeWorkspace) {
    return (
      <div className={cn("shrink-0", collapsed ? "mx-2 py-1" : "px-3 py-1")}>
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <div className="animate-pulse rounded-md bg-sidebar-hover w-7 h-7 shrink-0" />
          {!collapsed && <div className="animate-pulse rounded bg-sidebar-hover h-4 flex-1" />}
        </div>
      </div>
    );
  }

  // --- Dropdown panel ---
  const dropdown = open && canOpen && (
    <div
      className={cn(
        "absolute z-50 mt-1 rounded-lg border border-sidebar-border bg-sidebar shadow-lg",
        "ws-dropdown-enter",
        collapsed ? "left-full top-0 ml-2 w-56" : "left-0 right-0 top-full w-full min-w-[200px]",
      )}
    >
      {/* Workspace list */}
      {canSwitch && (
        <div className="p-1">
          {sortedWorkspaces.map((ws) => {
            const isActive = ws.id === activeWorkspace.id;
            return (
              <button
                type="button"
                key={ws.id}
                onClick={() => handleSelect(ws)}
                className={cn(
                  "flex items-center gap-2.5 w-full rounded-md px-2 py-2 text-sm text-left transition-all duration-150",
                  "text-sidebar-foreground",
                  isActive
                    ? "bg-sidebar-foreground/10 font-medium"
                    : "hover:bg-sidebar-foreground/5",
                )}
              >
                <WorkspaceAvatar name={ws.name} size="sm" variant="colored" />
                <div className="flex-1 min-w-0">
                  <span className="block truncate">{ws.name}</span>
                </div>
                {ws.memberCount <= 1 ? (
                  <span className="shrink-0" title="Personal">
                    <Lock className="w-3 h-3 text-sidebar-foreground/30" />
                  </span>
                ) : (
                  <span
                    className="flex items-center gap-1 text-[11px] text-sidebar-foreground/40 shrink-0"
                    title={`${ws.memberCount} members`}
                  >
                    <Users className="w-3 h-3" />
                    <span className="tabular-nums">{ws.memberCount}</span>
                  </span>
                )}
                <span className="w-4 shrink-0 flex items-center justify-center">
                  {isActive && <Check className="w-3.5 h-3.5 text-sidebar-primary" />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Settings link — keeps the workspace dropdown a one-stop shop for
          "I'm in workspace X, take me to its settings." Sign out lives in
          the UserMenu (bottom-left) since it's an identity action, not a
          workspace one. */}
      {canSwitch && <div className="mx-2 border-t border-sidebar-border" />}
      <div className="p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            navigate("/settings");
          }}
          className="flex items-center gap-2.5 w-full rounded-md px-2 py-2 text-sm text-left transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-foreground/5"
        >
          <Settings className="w-4 h-4 text-sidebar-foreground/60" />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );

  // --- Collapsed: avatar-only with popout dropdown ---
  if (collapsed) {
    return (
      <div ref={containerRef} className="relative shrink-0 mx-2 py-1">
        <button
          type="button"
          onClick={() => canOpen && setOpen(!open)}
          title={activeWorkspace.name}
          aria-label={`Workspace: ${activeWorkspace.name}`}
          aria-expanded={open}
          className={cn(
            "flex items-center justify-center w-full rounded-lg p-1.5 transition-all duration-150",
            canOpen && "hover:bg-sidebar-foreground/5 cursor-pointer",
            !canOpen && "cursor-default",
          )}
        >
          <WorkspaceAvatar name={activeWorkspace.name} size="md" />
        </button>
        {dropdown}
      </div>
    );
  }

  // --- Expanded: avatar + name + chevron (replaces logo) ---
  return (
    <div ref={containerRef} className="relative shrink-0 mx-2 py-1">
      <button
        type="button"
        onClick={() => canOpen && setOpen(!open)}
        aria-label={`Workspace: ${activeWorkspace.name}`}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2.5 w-full rounded-lg px-2 py-2 text-sm transition-all duration-150",
          canOpen ? "hover:bg-sidebar-foreground/5 cursor-pointer" : "cursor-default",
          open && "bg-sidebar-foreground/5",
        )}
      >
        <WorkspaceAvatar name={activeWorkspace.name} size="md" />
        <span className="flex-1 truncate text-left font-semibold text-sidebar-foreground">
          {activeWorkspace.name}
        </span>
        {canOpen && (
          <ChevronDown
            className={cn(
              "shrink-0 w-4 h-4 text-sidebar-foreground/40 transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {dropdown}
    </div>
  );
});
