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
 * don't apply — NimbleBrain runs single-process.
 */

interface PendingFlow {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  wsId: string;
  serverName: string;
}

const flows = new Map<string, PendingFlow>();

export function register(state: string, wsId: string, serverName: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    flows.set(state, { resolve, reject, wsId, serverName });
  });
}

/** Resolve a pending flow by state. Returns true if found. */
export function resolveWithCode(state: string, code: string): boolean {
  const flow = flows.get(state);
  if (!flow) return false;
  flows.delete(state);
  flow.resolve(code);
  return true;
}

/** Reject a pending flow by state. Returns true if found. */
export function rejectFlow(state: string, err: Error): boolean {
  const flow = flows.get(state);
  if (!flow) return false;
  flows.delete(state);
  flow.reject(err);
  return true;
}

/** For tests: drop all pending flows. */
export function _clearAll(): void {
  for (const flow of flows.values()) {
    flow.reject(new Error("flow registry cleared"));
  }
  flows.clear();
}
