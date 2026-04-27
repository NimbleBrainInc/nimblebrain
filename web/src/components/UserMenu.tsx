import { ChevronUp, LogOut, UserCog } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../context/SessionContext";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Avatar palette — same hues as WorkspaceSelector for consistency, but the
// user gets a different deterministic index (hashed from email/id, not
// workspace name) so the colors don't clash with the active workspace.
// ---------------------------------------------------------------------------

const AVATAR_PALETTE: [string, string][] = [
  ["#E8573F", "#fff"],
  ["#D97706", "#fff"],
  ["#059669", "#fff"],
  ["#0284C7", "#fff"],
  ["#7C3AED", "#fff"],
  ["#DB2777", "#fff"],
  ["#0D9488", "#fff"],
  ["#9333EA", "#fff"],
  ["#2563EB", "#fff"],
  ["#C2410C", "#fff"],
  ["#4F46E5", "#fff"],
  ["#0891B2", "#fff"],
];

function colorIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % AVATAR_PALETTE.length;
}

function initials(displayName: string, email: string): string {
  const source = displayName.trim() || email;
  const parts = source.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    const first = parts[0][0];
    const second = parts[1][0];
    if (first && second) return (first + second).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

interface UserMenuProps {
  collapsed: boolean;
  onLogout: () => void;
}

/**
 * Identity-bound menu pinned to the bottom of the shell sidebar.
 *
 * Sits below the workspace switcher (which is workspace-bound) — the two
 * are deliberate peers: workspace context at top (changes per session
 * activity), identity context at bottom (constant across the session).
 * Click reveals a popover with profile settings and sign out — the user's
 * always-available account surface, regardless of which page they're on.
 */
export const UserMenu = memo(function UserMenu({ collapsed, onLogout }: UserMenuProps) {
  const session = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const goToProfile = useCallback(() => {
    setOpen(false);
    navigate("/profile");
  }, [navigate]);

  const handleLogout = useCallback(() => {
    setOpen(false);
    onLogout();
  }, [onLogout]);

  if (!session?.user) {
    return null;
  }

  const { displayName, email } = session.user;
  const seed = session.user.id || email;
  const [bg, fg] = AVATAR_PALETTE[colorIndex(seed)];
  const label = displayName || email;

  return (
    <div ref={containerRef} className="relative shrink-0 mx-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Account: ${label}`}
        aria-expanded={open}
        className={cn(
          "flex items-center w-full rounded-lg transition-all duration-150 text-sm",
          "text-sidebar-foreground hover:bg-sidebar-foreground/5",
          open && "bg-sidebar-foreground/5",
          collapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-2",
        )}
      >
        <span
          className={cn(
            "inline-flex items-center justify-center font-semibold shrink-0 select-none rounded-md",
            "w-7 h-7 text-xs",
          )}
          style={{ backgroundColor: bg, color: fg }}
        >
          {initials(displayName ?? "", email ?? "")}
        </span>
        {!collapsed && (
          <>
            <div className="flex-1 min-w-0 text-left">
              <div className="truncate font-medium text-sidebar-foreground leading-tight">
                {label}
              </div>
              {displayName && email && displayName !== email && (
                <div className="truncate text-[11px] text-sidebar-foreground/50 leading-tight">
                  {email}
                </div>
              )}
            </div>
            <ChevronUp
              className={cn(
                "shrink-0 w-4 h-4 text-sidebar-foreground/40 transition-transform duration-200",
                open ? "rotate-0" : "rotate-180",
              )}
            />
          </>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-50 rounded-lg border border-sidebar-border bg-sidebar shadow-lg ws-dropdown-enter",
            collapsed
              ? "left-full bottom-0 ml-2 w-56"
              : "left-0 right-0 bottom-full mb-1 w-full min-w-[200px]",
          )}
        >
          {/* Identity header (collapsed only — expanded already shows it in the trigger) */}
          {collapsed && (
            <div className="px-3 py-2.5 border-b border-sidebar-border">
              <div className="truncate text-sm font-medium text-sidebar-foreground">{label}</div>
              {email && email !== label && (
                <div className="truncate text-[11px] text-sidebar-foreground/50">{email}</div>
              )}
            </div>
          )}
          <div className="p-1">
            <button
              type="button"
              onClick={goToProfile}
              className="flex items-center gap-2.5 w-full rounded-md px-2 py-2 text-sm text-left transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-foreground/5"
            >
              <UserCog className="w-4 h-4 text-sidebar-foreground/60" />
              <span>Profile settings</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-2.5 w-full rounded-md px-2 py-2 text-sm text-left transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-foreground/5"
            >
              <LogOut className="w-4 h-4 text-sidebar-foreground/60" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
