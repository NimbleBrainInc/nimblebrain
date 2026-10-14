// ---------------------------------------------------------------------------
// Opening: the shell side of `ai.nimblebrain/open` and `nb__open_app`.
//
// The server resolves what opens (`nb__open_app`, ADR-0052) and answers a
// destination; the shell puts it on screen. An app destination navigates to the
// app's route carrying an optional target in the router state, which the routed
// app view hands to the app as `ai.nimblebrain/navigate`. Pure: no React.
//
// The shell registers one opener (`provideShellOpener`) and every app frame's
// bridge reaches it through `shellOpener()`, so a frame mounted anywhere opens
// through the same code as the agent's call.
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

/**
 * Where an open lands, as `nb__open_app` answers it in `structuredContent`:
 * the chat panel at a conversation, or an app (by route, else server name) at
 * an optional target.
 */
export type OpenDestination =
  | { conversationId: string }
  | { app: string; name: string; target?: string };

/** The destination in a tool answer's `structuredContent`, or `null` when it carries none. */
export function destinationFrom(structured: unknown): OpenDestination | null {
  if (typeof structured !== "object" || structured === null) return null;
  const s = structured as Record<string, unknown>;
  if (typeof s.conversationId === "string") return { conversationId: s.conversationId };
  if (typeof s.app === "string" && typeof s.name === "string") {
    return {
      app: s.app,
      name: s.name,
      ...(typeof s.target === "string" ? { target: s.target } : {}),
    };
  }
  return null;
}

/** What the shell does when an app asks it to open something. Each rejects with the reason the app is told. */
export interface ShellOpener {
  open(uri: string): Promise<void>;
  openConnectorSettings(serverName: string): Promise<void>;
}

let currentOpener: ShellOpener | null = null;

/** Register the shell's opener; returns the unregister. */
export function provideShellOpener(opener: ShellOpener): () => void {
  currentOpener = opener;
  return () => {
    if (currentOpener === opener) currentOpener = null;
  };
}

/**
 * The bridge callbacks that reach the shell's opener. Each looks it up when
 * called, so a frame mounted before the shell registered still opens, and one
 * with no shell behind it is refused rather than left waiting.
 */
export const shellOpenCallbacks = {
  onOpen: (uri: string): Promise<void> =>
    currentOpener ? currentOpener.open(uri) : Promise.reject(new Error("Nothing here opens it")),
  onOpenConnectorSettings: (serverName: string): Promise<void> =>
    currentOpener
      ? currentOpener.openConnectorSettings(serverName)
      : Promise.reject(new Error("Nothing here opens it")),
};
