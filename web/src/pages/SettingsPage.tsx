import { NavLink, Outlet } from "react-router-dom";
import { useSession } from "../context/SessionContext";
import { useShellContext } from "../context/ShellContext";
import { resolveIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import type { PlacementEntry } from "../types";

// ── Platform sections (hardcoded, not extensible) ────────────────

interface PlatformSection {
  id: string;
  label: string;
  to: string;
  end?: boolean;
  adminOnly?: boolean;
}

const PLATFORM_SECTIONS: PlatformSection[] = [
  { id: "profile", label: "Profile", to: "/settings", end: true },
  { id: "model", label: "Model", to: "/settings/model" },
  { id: "usage", label: "Usage", to: "/settings/usage" },
  { id: "users", label: "Users", to: "/settings/users", adminOnly: true },
  { id: "workspaces", label: "Workspaces", to: "/settings/workspaces", adminOnly: true },
  { id: "about", label: "About", to: "/settings/about" },
];

// ── Component ────────────────────────────────────────────────────

export function SettingsPage() {
  const session = useSession();
  const orgRole = session?.user?.orgRole;
  const isAdmin = orgRole === "admin" || orgRole === "owner";

  // App settings panels — bundles register into the "settings" slot
  const shell = useShellContext();
  const appPanels: PlacementEntry[] = shell ? shell.forSlot("settings") : [];

  const visibleSections = PLATFORM_SECTIONS.filter((s) => !s.adminOnly || isAdmin);

  const navItemClass = (isActive: boolean) =>
    cn(
      "px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
      isActive
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:text-foreground hover:bg-muted",
    );

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      {/* Navigation — horizontal tabs on mobile, left sidebar on desktop */}
      <nav
        className="shrink-0 md:w-48 md:border-r border-b md:border-b-0 border-border flex md:flex-col overflow-x-auto md:overflow-x-visible md:overflow-y-auto"
        aria-label="Settings sections"
      >
        {/* Title — hidden on mobile */}
        <div className="hidden md:block px-4 pt-6 pb-3">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Settings</h1>
        </div>

        {/* Platform sections */}
        <div className="flex md:flex-col gap-0.5 px-2 py-1 md:py-0">
          {visibleSections.map((section) => (
            <NavLink
              key={section.id}
              to={section.to}
              end={section.end}
              className={({ isActive }) => navItemClass(isActive)}
            >
              {section.label}
            </NavLink>
          ))}

          {/* App settings panels (from bundles) — route-based deep links */}
          {appPanels.length > 0 && (
            <>
              <div className="hidden md:block mx-2 my-2 border-t border-border" />
              <div className="hidden md:block px-2 pb-1">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Apps
                </span>
              </div>
              {appPanels.map((panel) => {
                const Icon = panel.icon ? resolveIcon(panel.icon) : null;
                return (
                  <NavLink
                    key={panel.serverName}
                    to={`/settings/apps/${panel.serverName}`}
                    className={({ isActive }) =>
                      cn(navItemClass(isActive), "flex items-center gap-2")
                    }
                  >
                    {Icon && <Icon className="shrink-0 w-4 h-4" />}
                    <span className="truncate">{panel.label ?? panel.serverName}</span>
                  </NavLink>
                );
              })}
            </>
          )}
        </div>
      </nav>

      {/* Content area — all sections (platform + app) render via Outlet */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <Outlet />
      </div>
    </div>
  );
}
