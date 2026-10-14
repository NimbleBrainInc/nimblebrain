// ---------------------------------------------------------------------------
// The page name the top bar shows for a route.
//
// The bar names the page, in the same words as the sidebar row that opened it,
// so the two read as one place. An app that reports its own trail
// (`ai.nimblebrain/location`) overrides this with its trail's last label; this
// is the name when it does not, and on every non-app route. The workspace name
// is never part of it: the workspace switcher already says it.
//
// A settings area (a workspace's settings, the organization's, the profile)
// names its tab, after a crumb back to the area: "Settings › Members". The tab
// names come from `lib/settings-tabs`, the same list the area's side nav reads.
//
// Pure: a pathname and the shell's placements in, a string out.
// ---------------------------------------------------------------------------

import { roleAtLeast } from "../hooks/useScopedRole";
import type { PlacementEntry } from "../types";
import { identityAppSegment, isIdentityApp } from "./identity-apps";
import {
  landingTab,
  ORG_ABOUT_TAB,
  ORG_SETTINGS_TABS,
  PROFILE_TABS,
  type SettingsTab,
  WORKSPACE_SETTINGS_TABS,
} from "./settings-tabs";

/** A crumb before the page's name: a host page the reader can go back to. */
export interface PageCrumb {
  label: string;
  to: string;
}

/** Where a settings route sits: the crumbs to its area, then its tab's name. */
export interface SettingsLocation {
  crumbs: PageCrumb[];
  title: string;
}

function locate(
  area: string,
  root: string,
  tabs: readonly SettingsTab[],
  parts: string[],
  depth: number,
): SettingsLocation {
  const tab = tabs.find((t) => t.segment === parts[depth]);
  // An unknown or missing tab names the area alone, with nothing to go back to.
  if (!tab) return { crumbs: [], title: area };
  // The crumb goes where the area's root lands: its first tab. None on that tab
  // itself, where it would lead to the page already open, and none where the
  // landing tab needs a higher role than this one (About under Organization):
  // its guard would send the reader somewhere else entirely.
  const onLanding = tab.segment === landingTab(tabs) && parts.length === depth + 1;
  if (onLanding || !roleAtLeast(tab.minRole, tabs[0].minRole)) {
    return { crumbs: [], title: tab.label };
  }
  return { crumbs: [{ label: area, to: `${root}/${landingTab(tabs)}` }], title: tab.label };
}

/**
 * The crumbs and name for a settings route, or `null` off one. A deeper route
 * (a connector's page under Connectors, a workspace under Workspaces) takes its
 * tab's name: the page itself carries the way back to the tab.
 */
export function settingsLocation(pathname: string): SettingsLocation | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "w" && parts[2] === "settings") {
    return locate("Settings", `/w/${parts[1]}/settings`, WORKSPACE_SETTINGS_TABS, parts, 3);
  }
  if (parts[0] === "org") {
    return locate("Organization", "/org", [...ORG_SETTINGS_TABS, ORG_ABOUT_TAB], parts, 1);
  }
  if (parts[0] === "profile") {
    return locate("Profile", "/profile", PROFILE_TABS, parts, 1);
  }
  return null;
}

/** The page name for `pathname`, or `""` when the route names no page. */
export function pageTitle(pathname: string, placements: readonly PlacementEntry[]): string {
  const settings = settingsLocation(pathname);
  if (settings) return settings.title;
  const [first, , view, sub] = pathname.split("/").filter(Boolean);
  if (first === undefined) return "Home";
  if (first !== "w") return "";
  if (view === undefined) return "Overview";
  if (view === "notifications") return "Inbox";
  if (view === "context") return "Context";
  const placement =
    view === "app"
      ? placements.find((p) => p.route === sub)
      : placements.find(
          (p) => isIdentityApp(p.serverName) && identityAppSegment(p.serverName) === view,
        );
  return placement ? (placement.label ?? placement.route ?? placement.serverName) : "";
}
