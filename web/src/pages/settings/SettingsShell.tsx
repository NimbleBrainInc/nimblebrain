import { Fragment } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { roleAtLeast, type ScopedRole, useScopedRole } from "../../hooks/useScopedRole";
import { resolveIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";

// ── Single-scope settings shell ──────────────────────────────────────
//
// Renders one scope's settings nav (a title + a flat list of sections,
// optionally with nested sub-items) plus an `<Outlet/>` for the active
// tab. Settings used to be one page grouped by scope (workspace vs org);
// each scope now owns its own URL subtree (`/w/:slug/settings`, `/org`)
// so the shell is single-scope and the cross-scope grouping is gone.
//
// Each item declares the minimum role to *see* it (defense in depth — the
// backend tools enforce the real write boundary). A `footer` item pins to
// the bottom and is role-exempt (e.g. About).

export interface SettingsNavSubItem {
  id: string;
  label: string;
  to: string;
  /** Lucide icon name (resolved via `resolveIcon`). */
  icon?: string;
}

export interface SettingsNavItem {
  id: string;
  label: string;
  to: string;
  end?: boolean;
  /** Minimum role required to see this entry. Default: `ws_member`. */
  minRole?: ScopedRole;
  /** Nested links rendered under this item (e.g. per-app settings panels). */
  children?: SettingsNavSubItem[];
}

export interface SettingsShellProps {
  title: string;
  items: SettingsNavItem[];
  /** Optional bottom-pinned link, exempt from role filtering (e.g. About). */
  footer?: { id: string; label: string; to: string; end?: boolean };
}

const navItemClass = (isActive: boolean) =>
  cn(
    "px-3 py-2 text-sm font-medium rounded-sm transition-colors whitespace-nowrap",
    isActive
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:text-foreground hover:bg-muted",
  );

export function SettingsShell({ title, items, footer }: SettingsShellProps) {
  const role = useScopedRole();
  const visible = items.filter((s) => roleAtLeast(role, s.minRole ?? "ws_member"));

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      <nav
        className="shrink-0 md:w-56 md:border-r border-b md:border-b-0 border-border flex md:flex-col overflow-x-auto md:overflow-x-visible md:overflow-y-auto"
        aria-label={`${title} sections`}
      >
        <div className="hidden md:block px-4 pt-6 pb-3">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        </div>

        {/* Mobile: single horizontal scroll row (no nesting) */}
        <div className="flex md:hidden gap-0.5 px-2 py-1">
          {visible.map((section) => (
            <NavLink
              key={section.id}
              to={section.to}
              end={section.end}
              className={({ isActive }) => navItemClass(isActive)}
            >
              {section.label}
            </NavLink>
          ))}
          {footer && (
            <NavLink
              to={footer.to}
              end={footer.end}
              className={({ isActive }) => navItemClass(isActive)}
            >
              {footer.label}
            </NavLink>
          )}
        </div>

        {/* Desktop: vertical nav with optional nested sub-items */}
        <div className="hidden md:flex md:flex-col px-2 pb-3">
          <div className="mt-1 flex flex-col gap-0.5">
            {visible.map((section) => (
              <Fragment key={section.id}>
                <NavLink
                  to={section.to}
                  end={section.end}
                  className={({ isActive }) => navItemClass(isActive)}
                >
                  {section.label}
                </NavLink>
                {section.children && section.children.length > 0 && (
                  <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
                    {section.children.map((child) => {
                      const Icon = child.icon ? resolveIcon(child.icon) : null;
                      return (
                        <NavLink
                          key={child.id}
                          to={child.to}
                          className={({ isActive }) =>
                            cn(navItemClass(isActive), "flex items-center gap-2 text-xs")
                          }
                        >
                          {Icon && <Icon className="shrink-0 w-3.5 h-3.5" />}
                          <span className="truncate">{child.label}</span>
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </Fragment>
            ))}
          </div>

          {footer && (
            <div className="mt-6 pt-3 border-t border-border flex flex-col">
              <NavLink
                to={footer.to}
                end={footer.end}
                className={({ isActive }) => navItemClass(isActive)}
              >
                {footer.label}
              </NavLink>
            </div>
          )}
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <Outlet />
      </div>
    </div>
  );
}
