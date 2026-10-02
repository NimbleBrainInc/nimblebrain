// ---------------------------------------------------------------------------
// The page name the top bar shows for a route.
//
// The bar names the page, in the same words as the sidebar row that opened it,
// so the two read as one place. An app that reports its own trail
// (`ai.nimblebrain/location`) overrides this with its trail's last label; this
// is the name when it does not, and on every non-app route. The workspace name
// is never part of it: the workspace switcher already says it.
//
// Pure: a pathname and the shell's placements in, a string out.
// ---------------------------------------------------------------------------

import type { PlacementEntry } from "../types";
import { identityAppSegment, isIdentityApp } from "./identity-apps";

const FIXED: Record<string, string> = {
  profile: "Profile",
  org: "Organization",
};

/** The page name for `pathname`, or `""` when the route names no page. */
export function pageTitle(pathname: string, placements: readonly PlacementEntry[]): string {
  const [first, , view, sub] = pathname.split("/").filter(Boolean);
  if (first === undefined) return "Home";
  if (first !== "w") return FIXED[first] ?? "";
  if (view === undefined) return "Overview";
  if (view === "notifications") return "Inbox";
  if (view === "context") return "Context";
  // The sidebar's Connectors row opens the connectors settings tab; every
  // other settings tab is reached from the workspace switcher as Settings.
  if (view === "settings") return sub === "connectors" ? "Connectors" : "Settings";
  const placement =
    view === "app"
      ? placements.find((p) => p.route === sub)
      : placements.find(
          (p) => isIdentityApp(p.serverName) && identityAppSegment(p.serverName) === view,
        );
  return placement ? (placement.label ?? placement.route ?? placement.serverName) : "";
}
