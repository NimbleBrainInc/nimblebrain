// ---------------------------------------------------------------------------
// Actions registry (>) — the palette's command set.
//
// Each ActionDef is a static command with an availability predicate (role,
// focused-workspace presence) and a run closure that receives both the
// imperative run-context and the read-only source-context (the latter for
// building workspace-scoped routes). The actions source filters by
// availability, scores against the query, and projects survivors into
// CommandItems.
//
// The registry shape leaves room for apps/sources to contribute actions later
// without touching the matcher or container.
// ---------------------------------------------------------------------------

import type { CommandRunContext, CommandSourceContext } from "./types";

export interface ActionDef {
  id: string;
  title: string;
  keywords?: string[];
  /** lucide-react icon name. */
  icon: string;
  /** Hidden when this returns false (e.g. org-admin-only, needs focused ws). */
  available?: (ctx: CommandSourceContext) => boolean;
  run: (run: CommandRunContext, ctx: CommandSourceContext) => void;
}

const hasWorkspace = (ctx: CommandSourceContext): boolean => Boolean(ctx.activeWorkspaceSlug);
const isOrgAdmin = (ctx: CommandSourceContext): boolean => ctx.orgRole === "org_admin";

export const ACTIONS: ActionDef[] = [
  {
    id: "go-home",
    title: "Go to Home",
    keywords: ["home", "dashboard"],
    icon: "Home",
    run: (run) => {
      run.navigate("/");
      run.closePalette();
    },
  },
  {
    id: "toggle-chat",
    title: "Open / close chat",
    keywords: ["chat", "assistant", "panel"],
    icon: "MessageSquare",
    run: (run) => {
      run.toggleChat();
      run.closePalette();
    },
  },
  {
    id: "toggle-sidebar",
    title: "Toggle sidebar",
    keywords: ["sidebar", "collapse", "expand"],
    icon: "PanelLeft",
    run: (run) => {
      run.toggleSidebar();
      run.closePalette();
    },
  },
  {
    id: "toggle-theme",
    title: "Toggle theme (light / dark)",
    keywords: ["theme", "dark", "light", "appearance"],
    icon: "SunMoon",
    run: (run) => {
      run.toggleTheme();
      run.closePalette();
    },
  },
  {
    id: "keyboard-shortcuts",
    title: "Keyboard shortcuts",
    keywords: ["shortcuts", "keys", "help"],
    icon: "Keyboard",
    run: (run) => {
      run.openKeyboardShortcuts();
      run.closePalette();
    },
  },
  {
    id: "workspace-settings",
    title: "Workspace settings",
    keywords: ["settings", "workspace", "preferences"],
    icon: "Settings",
    available: hasWorkspace,
    run: (run, ctx) => {
      run.navigate(`/w/${ctx.activeWorkspaceSlug}/settings`);
      run.closePalette();
    },
  },
  {
    id: "manage-connectors",
    title: "Manage connectors",
    keywords: ["connectors", "integrations", "mcp", "tools"],
    icon: "Plug",
    available: hasWorkspace,
    run: (run, ctx) => {
      run.navigate(`/w/${ctx.activeWorkspaceSlug}/settings/connectors`);
      run.closePalette();
    },
  },
  {
    id: "org-settings",
    title: "Organization settings",
    keywords: ["org", "organization", "admin", "settings"],
    icon: "Building2",
    available: isOrgAdmin,
    run: (run) => {
      run.navigate("/org");
      run.closePalette();
    },
  },
  {
    id: "logout",
    title: "Log out",
    keywords: ["logout", "sign out", "log off"],
    icon: "LogOut",
    run: (run) => {
      run.closePalette();
      run.logout();
    },
  },
];
