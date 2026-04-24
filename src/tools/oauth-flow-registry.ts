/**
 * Process-local registry for pending OAuth authorization flows.
 *
 * Bridges `WorkspaceOAuthProvider` (initiator) and the
 * `/v1/mcp-auth/callback` route (code receiver) when the auth flow requires
 * a real browser round-trip. Keyed by the OAuth `state` parameter.
 *
 * For headless flows (Reboot Anonymous in `rbt dev`), the provider resolves
 * its own deferred directly from `redirectToAuthorization` and does not
 * register here — the registry is only used when an HTTP callback actually
 * arrives from outside the provider's control.
 *
 * State is not persisted: OAuth flows complete in seconds, and if a process
 * restart interrupts one, re-initiating is correct. Cross-process concerns
 * don't apply — NimbleBrain runs single-process. Intra-process leaks, on
 * the other hand, matter: an orphaned pending-flow entry (user closed the
 * tab, network failure, never hit the callback) would keep a promise alive
 * forever if not timed out. Every registration is bounded by a 15-minute
 * TTL — long enough for a reasonable interactive OAuth round-trip, short
 * enough that a stuck flow is reclaimed before it piles up.
 */

interface PendingFlow {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  wsId: string;
  serverName: string;
  timeout: ReturnType<typeof setTimeout>;
}

const flows = new Map<string, PendingFlow>();

/**
 * Default TTL for a pending flow. Exposed as a constant so tests can target
 * the same boundary condition without hardcoding magic numbers.
 */
export const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1000;

export function register(
  state: string,
  wsId: string,
  serverName: string,
  ttlMs: number = DEFAULT_FLOW_TTL_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Only reject if we haven't already been resolved/rejected by the
      // callback. `flows.delete` before `reject` prevents the reject
      // callback from racing with a late callback resolve.
      const existing = flows.get(state);
      if (existing?.timeout === timeout) {
        flows.delete(state);
        reject(
          new Error(`[oauth-flow-registry] flow ${state.slice(0, 8)}… timed out after ${ttlMs}ms`),
        );
      }
    }, ttlMs);
    // `unref` so a stuck flow's timer doesn't keep the event loop alive
    // in short-lived CLI invocations. In the HTTP server process this is
    // a no-op — the server keeps the loop alive independently.
    timeout.unref?.();
    flows.set(state, { resolve, reject, wsId, serverName, timeout });
  });
}

/** Resolve a pending flow by state. Returns true if found. */
export function resolveWithCode(state: string, code: string): boolean {
  const flow = flows.get(state);
  if (!flow) return false;
  flows.delete(state);
  clearTimeout(flow.timeout);
  flow.resolve(code);
  return true;
}

/** Reject a pending flow by state. Returns true if found. */
export function rejectFlow(state: string, err: Error): boolean {
  const flow = flows.get(state);
  if (!flow) return false;
  flows.delete(state);
  clearTimeout(flow.timeout);
  flow.reject(err);
  return true;
}

/** For tests: drop all pending flows. */
export function _clearAll(): void {
  for (const flow of flows.values()) {
    clearTimeout(flow.timeout);
    flow.reject(new Error("flow registry cleared"));
  }
  flows.clear();
}
