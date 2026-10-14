// ---------------------------------------------------------------------------
// Opening an app at a view: the shell side of `openApp` and `nb__open_app`.
//
// `openApp` (the shell's action, from an app's `ai.nimblebrain/action` or the
// agent's `nb__open_app`) navigates to the app's route carrying an optional
// target in the router state. The routed app view reads it and hands it to the
// app as `ai.nimblebrain/navigate`. Pure: no React.
// ---------------------------------------------------------------------------

import type { PlacementEntry } from "../types";
import { identityAppSegment, isIdentityApp } from "./identity-apps";

/** The router state an app route may carry. */
export interface AppRouteState {
  /** A view inside the app, by its stable address, to open once it is on screen. */
  appTarget?: string;
}

/** The agent's open-app tool: the `nb` system source's `open_app`. */
const OPEN_APP_WIRE_NAME = "nb__open_app";

/** True for a call to the agent's open-app tool. */
export function isOpenAppCall(wireName: string): boolean {
  return wireName === OPEN_APP_WIRE_NAME;
}

/** The target an app route's router state carries, if any. */
export function appTargetFrom(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const target = (state as AppRouteState).appTarget;
  return typeof target === "string" && target.length > 0 ? target : undefined;
}

/**
 * Where the app `name` renders: an app route (`<route>`, which the shell
 * prefixes with `/w/<slug>/app/`) or, for an identity view, its absolute path
 * `/w/<slug>/<segment>`. Matches an exact route, then a server name, then a
 * case-insensitive sidebar label — the forms the server's `findOpenableApp`
 * accepts, so whatever `nb__open_app` opens, this resolves. `null` when no
 * placement matches, or an identity view has no workspace to render under.
 */
export function resolveAppRouteIn(
  placements: readonly PlacementEntry[],
  name: string,
  slug: string | null | undefined,
): string | null {
  const routed = placements.filter((p) => p.route);
  const wanted = name.trim().toLowerCase();
  const found =
    routed.find((p) => p.route === name) ??
    routed.find((p) => p.serverName === name) ??
    routed.find((p) => p.label?.toLowerCase() === wanted);
  if (!found?.route) return null;
  if (isIdentityApp(found.serverName)) {
    return slug ? `/w/${slug}/${identityAppSegment(found.serverName)}` : null;
  }
  return found.route;
}
