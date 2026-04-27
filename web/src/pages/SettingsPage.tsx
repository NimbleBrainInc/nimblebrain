import { Fragment } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useShellContext } from "../context/ShellContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { roleAtLeast, type ScopedRole, useScopedRole } from "../hooks/useScopedRole";
import { resolveIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import type { PlacementEntry } from "../types";

// ── Section + group schema ───────────────────────────────────────
//
// Settings nav is grouped by *scope*: what does this thing affect?
//   workspace     — the active workspace (its identity, members, app config)
//   organization  — the org as a whole (manage all workspaces / users)
//
// Profile is intentionally NOT in this nav — and it's also NOT under the
// `/settings/*` tree at all. It lives at `/profile` (top-level) because
// identity isn't a setting; it's a separate concern. The shell's
// bottom-left `UserMenu` is the canonical path. Old `/settings/profile`
// URLs redirect to `/profile`.
//
// Each section declares the minimum role required to see its nav entry.
// The route guard re-checks on render so URL-hacks can't bypass nav
// filtering (defense in depth — the backend tools enforce the actual
// security boundary on writes).

type SectionGroup = "workspace" | "organization";

interface PlatformSection {
  id: string;
  label: string;
  to: string;
  end?: boolean;
  group: SectionGroup;
  /** Minimum role required to see this entry. Default: `ws_member` (any signed-in user with a workspace). */
  minRole?: ScopedRole;
}

const GROUP_LABELS: Record<SectionGroup, string> = {
  workspace: "This Workspace",
  organization: "Organization",
};

const PLATFORM_SECTIONS: PlatformSection[] = [
  // This workspace — visible to any member; some sub-pages gate Save behind ws_admin.
  // Usage lives here because the backend scopes usage data per workspace
  // (`runtime.getWorkspaceScopedDir()`).
  {
    id: "ws-general",
    label: "General",
    to: "/settings/workspace/general",
    group: "workspace",
    minRole: "ws_member",
  },
  {
    id: "ws-members",
    label: "Members",
    to: "/settings/workspace/members",
    group: "workspace",
    minRole: "ws_member",
  },
  {
    id: "ws-usage",
    label: "Usage",
    to: "/settings/workspace/usage",
    group: "workspace",
    minRole: "ws_member",
  },
  // Apps index — per-bundle entries are appended dynamically below.
  {
    id: "ws-apps",
    label: "Apps",
    to: "/settings/workspace/apps",
    group: "workspace",
    end: true,
    minRole: "ws_member",
  },
  {
    id: "ws-skills",
    label: "Skills",
    to: "/settings/workspace/skills",
    group: "workspace",
    minRole: "ws_member",
  },

  // Organization — admin-only.
  // Model lives here because `set_model_config` writes to the global
  // `nimblebrain.json` (instance-wide config affecting every workspace).
  {
    id: "org-model",
    label: "Model",
    to: "/settings/org/model",
    group: "organization",
    minRole: "org_admin",
  },
  {
    id: "org-workspaces",
    label: "Workspaces",
    to: "/settings/org/workspaces",
    group: "organization",
    minRole: "org_admin",
  },
  {
    id: "org-users",
    label: "Users",
    to: "/settings/org/users",
    group: "organization",
    minRole: "org_admin",
  },
];

// Footer — rendered separately in the bottom-of-nav slot below About,
// not part of the scoped groups.
const ABOUT_SECTION = {
  id: "about",
  label: "About",
  to: "/settings/about",
  end: false,
  minRole: "none" as const,
};

// ── Component ────────────────────────────────────────────────────

export function SettingsPage() {
  const role = useScopedRole();
  const { activeWorkspace } = useWorkspaceContext();
  const shell = useShellContext();

  // Per-bundle settings panels (the bundles' own settings UIs registered via
  // the `settings` placement slot). Workspace-scoped — `forSlot` already
  // filters to the active workspace's installed bundles.
  const appPanels: PlacementEntry[] = shell ? shell.forSlot("settings") : [];

  // Filter sections by role. Bundle apps panels show only when the user
  // can see the workspace (ws_member or higher); when no active workspace
  // is set, the workspace group hides entirely (handled below).
  const hasActiveWorkspace = activeWorkspace !== null;
  const visibleSections = PLATFORM_SECTIONS.filter((s) => {
    if (!roleAtLeast(role, s.minRole ?? "ws_member")) return false;
    if (s.group === "workspace" && !hasActiveWorkspace) return false;
    return true;
  });

  // Group sections for rendering with header labels.
  const grouped: Record<SectionGroup, PlatformSection[]> = {
    workspace: visibleSections.filter((s) => s.group === "workspace"),
    organization: visibleSections.filter((s) => s.group === "organization"),
  };

  const navItemClass = (isActive: boolean) =>
    cn(
      "px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
      isActive
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:text-foreground hover:bg-muted",
    );

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      <nav
        className="shrink-0 md:w-56 md:border-r border-b md:border-b-0 border-border flex md:flex-col overflow-x-auto md:overflow-x-visible md:overflow-y-auto"
        aria-label="Settings sections"
      >
        <div className="hidden md:block px-4 pt-6 pb-3">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Settings</h1>
        </div>

        {/* Mobile: single horizontal scroll row of all visible sections (no group labels) */}
        <div className="flex md:hidden gap-0.5 px-2 py-1">
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
          <NavLink
            to={ABOUT_SECTION.to}
            end={ABOUT_SECTION.end}
            className={({ isActive }) => navItemClass(isActive)}
          >
            {ABOUT_SECTION.label}
          </NavLink>
        </div>

        {/* Desktop: grouped scoped nav with section labels */}
        <div className="hidden md:flex md:flex-col px-2 pb-3">
          {(["workspace", "organization"] as const)
            .filter((g) => grouped[g].length > 0)
            .map((group, idx) => {
              const sections = grouped[group];
              return (
                <SettingsGroup key={group} label={GROUP_LABELS[group]} isFirst={idx === 0}>
                  {sections.map((section) => (
                    <Fragment key={section.id}>
                      <NavLink
                        to={section.to}
                        end={section.end}
                        className={({ isActive }) => navItemClass(isActive)}
                      >
                        {section.label}
                      </NavLink>
                      {/* App sub-panels nest under the Apps entry specifically,
                       *  so reordering sections doesn't reparent them.
                       */}
                      {section.id === "ws-apps" && appPanels.length > 0 && (
                        <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
                          {appPanels.map((panel) => {
                            const Icon = panel.icon ? resolveIcon(panel.icon) : null;
                            return (
                              <NavLink
                                key={panel.serverName}
                                to={`/settings/workspace/apps/${panel.serverName}`}
                                className={({ isActive }) =>
                                  cn(navItemClass(isActive), "flex items-center gap-2 text-xs")
                                }
                              >
                                {Icon && <Icon className="shrink-0 w-3.5 h-3.5" />}
                                <span className="truncate">{panel.label ?? panel.serverName}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </Fragment>
                  ))}
                </SettingsGroup>
              );
            })}

          {/*
            Footer: About — divider + the link as a flex column so the
            NavLink stretches to full nav width (other entries inherit this
            stretch from their parent `flex flex-col` group; About used
            to live in a plain div which let it shrink to content width
            and looked visually narrower than its siblings).
          */}
          <div className="mt-6 pt-3 border-t border-border flex flex-col">
            <NavLink
              to={ABOUT_SECTION.to}
              end={ABOUT_SECTION.end}
              className={({ isActive }) => navItemClass(isActive)}
            >
              {ABOUT_SECTION.label}
            </NavLink>
          </div>
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * A scoped group with a section label and (between groups) a top divider
 * carrying the visual separation work.
 *
 * `isFirst` skips the top divider — the first visible group sits directly
 * below the page title with nothing above it to separate from. Adding a
 * divider there would float disconnected at the top of the nav.
 */
function SettingsGroup({
  label,
  children,
  isFirst,
}: {
  label: string;
  children: React.ReactNode;
  isFirst?: boolean;
}) {
  return (
    <div className={cn(isFirst ? "mt-1" : "mt-5 pt-4 border-t border-border/60")}>
      <SectionHeader label={label} />
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 pb-2">
      <span className="text-[11px] font-bold text-foreground/70 uppercase tracking-[0.08em]">
        {label}
      </span>
    </div>
  );
}
