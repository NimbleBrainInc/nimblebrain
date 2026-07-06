import { Building2, ChevronUp, LogOut, UserCog } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../context/SessionContext";
import { roleAtLeast, useScopedRole } from "../hooks/useScopedRole";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Avatar palette. The user gets a deterministic index hashed from
// email/id; T013's sidebar workspace+apps navigator will adopt the same
// palette so workspace + identity avatars stay visually consistent
// without colliding (different hash inputs → different hues).
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
  /**
   * Direction the dropdown opens relative to its trigger. `"down"` for
   * top-anchored placements (current sidebar layout); `"up"` for
   * legacy bottom-anchored callers. Defaults to `"down"`.
   */
  dropdownDirection?: "up" | "down";
}

/** Colored initials chip standing in for the user's avatar. */
function Avatar({
  displayName,
  email,
  bg,
  fg,
}: {
  displayName: string;
  email: string;
  bg: string;
  fg: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center font-semibold shrink-0 select-none rounded-sm",
        "w-7 h-7 text-xs",
      )}
      style={{ backgroundColor: bg, color: fg }}
    >
      {initials(displayName ?? "", email ?? "")}
    </span>
  );
}

/** Name/email lines plus the open/close chevron, shown when the sidebar is expanded. */
function TriggerDetails({
  label,
  displayName,
  email,
  open,
}: {
  label: string;
  displayName: string;
  email: string;
  open: boolean;
}) {
  return (
    <>
      <div className="flex-1 min-w-0 text-left">
        <div className="truncate font-medium text-sidebar-foreground leading-tight">{label}</div>
        {displayName && email && displayName !== email && (
          <div className="truncate text-2xs text-sidebar-foreground/50 leading-tight">{email}</div>
        )}
      </div>
      <ChevronUp
        className={cn(
          "shrink-0 w-4 h-4 text-sidebar-foreground/50 transition-transform duration-200",
          open ? "rotate-0" : "rotate-180",
        )}
      />
    </>
  );
}

/** Absolute-position classes for the popover given collapse state and open direction. */
function dropdownPositionClass(collapsed: boolean, dropdownDirection: "up" | "down"): string {
  if (collapsed) {
    return cn("left-full ml-2 w-56", dropdownDirection === "up" ? "bottom-0" : "top-0");
  }
  return cn(
    "left-0 right-0 w-full min-w-[200px]",
    dropdownDirection === "up" ? "bottom-full mb-1" : "top-full mt-1",
  );
}

/** Identity header at the top of the popover (collapsed only — expanded shows it in the trigger). */
function DropdownIdentityHeader({ label, email }: { label: string; email: string }) {
  return (
    <div className="px-3 py-2.5 border-b border-sidebar-border">
      <div className="truncate text-sm font-medium text-sidebar-foreground">{label}</div>
      {email && email !== label && (
        <div className="truncate text-2xs text-sidebar-foreground/50">{email}</div>
      )}
    </div>
  );
}

/** Action list inside the popover: profile settings, organization (admins), and sign out. */
function DropdownActions({
  isOrgAdmin,
  onProfile,
  onOrgSettings,
  onSignOut,
}: {
  isOrgAdmin: boolean;
  onProfile: () => void;
  onOrgSettings: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="p-1">
      <button
        type="button"
        onClick={onProfile}
        className="flex items-center gap-2.5 w-full rounded-sm px-2 py-2 text-sm text-left transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-foreground/5"
      >
        <UserCog className="w-4 h-4 text-sidebar-foreground/60" />
        <span>Profile settings</span>
      </button>
      {isOrgAdmin && (
        <button
          type="button"
          onClick={onOrgSettings}
          className="flex items-center gap-2.5 w-full rounded-sm px-2 py-2 text-sm text-left transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-foreground/5"
        >
          <Building2 className="w-4 h-4 text-sidebar-foreground/60" />
          <span>Organization</span>
        </button>
      )}
      <button
        type="button"
        onClick={onSignOut}
        className="flex items-center gap-2.5 w-full rounded-sm px-2 py-2 text-sm text-left transition-all duration-150 text-sidebar-foreground hover:bg-sidebar-foreground/5"
      >
        <LogOut className="w-4 h-4 text-sidebar-foreground/60" />
        <span>Sign out</span>
      </button>
    </div>
  );
}

/** The account popover: optional identity header stacked over the action list. */
function AccountDropdown({
  collapsed,
  dropdownDirection,
  label,
  email,
  isOrgAdmin,
  onProfile,
  onOrgSettings,
  onSignOut,
}: {
  collapsed: boolean;
  dropdownDirection: "up" | "down";
  label: string;
  email: string;
  isOrgAdmin: boolean;
  onProfile: () => void;
  onOrgSettings: () => void;
  onSignOut: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute z-50 rounded-sm border border-sidebar-border bg-sidebar shadow-lg ws-dropdown-enter",
        dropdownPositionClass(collapsed, dropdownDirection),
      )}
    >
      {collapsed && <DropdownIdentityHeader label={label} email={email} />}
      <DropdownActions
        isOrgAdmin={isOrgAdmin}
        onProfile={onProfile}
        onOrgSettings={onOrgSettings}
        onSignOut={onSignOut}
      />
    </div>
  );
}

/**
 * Identity-bound menu at the top-left of the shell sidebar.
 *
 * Identity sits at the top as a constant-across-session anchor; the
 * workspace+apps navigator (T013) sits below it. Click reveals a
 * popover with profile settings and sign out — the user's
 * always-available account surface, regardless of which page they're on.
 *
 * `dropdownDirection` toggles whether the popover opens below
 * (top-anchored — default) or above (bottom-anchored — kept for any
 * legacy mount points).
 */
export const UserMenu = memo(function UserMenu({
  collapsed,
  onLogout,
  dropdownDirection = "down",
}: UserMenuProps) {
  const session = useSession();
  const navigate = useNavigate();
  const isOrgAdmin = roleAtLeast(useScopedRole(), "org_admin");
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

  const goToOrgSettings = useCallback(() => {
    setOpen(false);
    navigate("/org");
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
          "flex items-center w-full rounded-sm transition-all duration-150 text-sm",
          "text-sidebar-foreground hover:bg-sidebar-foreground/5",
          open && "bg-sidebar-foreground/5",
          collapsed ? "justify-center p-1.5" : "gap-2.5 px-2 py-2",
        )}
      >
        <Avatar displayName={displayName} email={email} bg={bg} fg={fg} />
        {!collapsed && (
          <TriggerDetails label={label} displayName={displayName} email={email} open={open} />
        )}
      </button>

      {open && (
        <AccountDropdown
          collapsed={collapsed}
          dropdownDirection={dropdownDirection}
          label={label}
          email={email}
          isOrgAdmin={isOrgAdmin}
          onProfile={goToProfile}
          onOrgSettings={goToOrgSettings}
          onSignOut={handleLogout}
        />
      )}
    </div>
  );
});
