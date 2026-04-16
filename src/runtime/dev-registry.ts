/**
 * Dev mode registry — tracks which apps are being served from local Vite dev servers.
 *
 * When `nb dev --app <path>` is used, the specified app's resources are served
 * from the Vite dev server instead of the bundle's static HTML.
 */

const devApps = new Map<string, string>();

/** Register an app as being served from a local dev URL. */
export function setAppDevMode(appName: string, devUrl: string): void {
  devApps.set(appName, devUrl);
}

/** Get the dev server URL for an app, if it's in dev mode. */
export function getAppDevUrl(appName: string): string | undefined {
  return devApps.get(appName);
}

/** Check if an app is in dev mode. */
export function isDevMode(appName: string): boolean {
  return devApps.has(appName);
}
