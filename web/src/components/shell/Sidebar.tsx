// ---------------------------------------------------------------------------
// Sidebar (shell) — Stage 2 / T013
//
// Mounting point for the new WORKSPACES navigator section. ShellLayout
// renders this component into the sidebar's top zone alongside the
// existing placement-driven nav.
//
// This module exists as the spec-named entry point — components inside
// `shell/` are the workspace navigator's surface area (heading + rows
// + app list). ShellLayout keeps owning the outer chrome (resize,
// drawer, UserMenu).
//
// Composed of two sub-components for testability:
//   - `SidebarWorkspaceNav` — the WORKSPACES heading + workspace rows
//   - Individual rows handle their own selection / navigation
//
// Re-exports the navigator under the spec's `Sidebar` name so existing
// docs that reference `shell/Sidebar.tsx` (the task spec literal) resolve
// to the same component.
// ---------------------------------------------------------------------------

import { SidebarWorkspaceNav } from "./SidebarWorkspaceNav";

export function Sidebar() {
  return <SidebarWorkspaceNav />;
}

export { SidebarWorkspaceNav };
