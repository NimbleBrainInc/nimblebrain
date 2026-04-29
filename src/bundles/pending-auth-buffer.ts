/**
 * Process-local buffer for interactive-OAuth notifications captured at
 * workspace-bundle boot time, before the BundleLifecycleManager is
 * constructed.
 *
 * The boot ordering is:
 *
 *   1. `startWorkspaceBundles` runs each URL bundle's
 *      `startBundleSource`. If a bundle hits the interactive OAuth
 *      branch, the provider's `onInteractiveAuthRequired` callback
 *      fires (with the authorization URL) DURING the start path,
 *      well before lifecycle exists.
 *   2. `Runtime.start` then constructs `BundleLifecycleManager` and
 *      calls `seedInstance` for every booted bundle.
 *
 * Without a buffer, the pending_auth signal would be dropped on the
 * floor — lifecycle would seed the bundle as `running` and the UI banner
 * would never appear. The buffer holds (wsId, serverName) →
 * authorizationUrl entries between (1) and (2).
 *
 * `seedInstance` consumes the buffer and creates the appropriate
 * Connection in `pending_auth`. After consumption the entry is removed
 * so the seed is idempotent — subsequent `recordConnectionStateChange`
 * calls become the source of truth.
 *
 * Lives at module scope (process-local Map). Single-process
 * deployments only, which matches everything else in this codebase.
 */

const buffer = new Map<string, string>();

function key(wsId: string, serverName: string): string {
  return `${wsId}|${serverName}`;
}

/** Record that a URL bundle hit the interactive-OAuth branch during boot. */
export function setPendingAuth(wsId: string, serverName: string, authorizationUrl: string): void {
  buffer.set(key(wsId, serverName), authorizationUrl);
}

/**
 * Consume a buffered pending_auth entry. Returns the URL and clears the
 * entry, or null if no entry exists. Idempotent.
 */
export function consumePendingAuth(wsId: string, serverName: string): string | null {
  const k = key(wsId, serverName);
  const url = buffer.get(k);
  if (!url) return null;
  buffer.delete(k);
  return url;
}

/** Test-only: drop everything. */
export function _clearAllPendingAuth(): void {
  buffer.clear();
}

// ── Connection-running notifications ────────────────────────────────
//
// startup.ts's URL-bundle `start().then` path needs to notify the
// lifecycle that a Connection has finished its OAuth dance and is now
// running, so the BundleInstance.connections map can transition out of
// pending_auth and the SSE event clears the UI banner. The notification
// fires after `Runtime.start` has constructed `BundleLifecycleManager`
// (the user only completes auth post-boot), so we don't need a buffer —
// a direct callback registered by Runtime suffices.

type ConnectionRunningHandler = (wsId: string, serverName: string) => void;
let runningHandler: ConnectionRunningHandler | null = null;

/**
 * Wire the lifecycle's connection-running notification path. Called
 * once from `Runtime.start` after the lifecycle exists. Subsequent
 * calls to `notifyConnectionRunning` route to the registered handler.
 */
export function setConnectionRunningHandler(handler: ConnectionRunningHandler | null): void {
  runningHandler = handler;
}

/**
 * Background `start()` succeeded — fire the registered lifecycle
 * notifier. No-op if no handler is wired (early boot, unit tests).
 */
export function notifyConnectionRunning(wsId: string, serverName: string): void {
  if (runningHandler) runningHandler(wsId, serverName);
}
