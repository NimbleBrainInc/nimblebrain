/**
 * Process-local registry for pending Composio connect flows.
 *
 * A record is created at `/v1/composio-auth/initiate*` — behind `requireAuth`,
 * with the owner derived from the authenticated session — and consumed once at
 * the unauthenticated `/v1/composio-auth/callback` (the return leg from the
 * vendor). This server-side record, not the `nb_composio_state` cookie, is the
 * anti-forgery boundary: the callback derives `owner` and `connectorId` from
 * the record rather than the query string, and a callback whose `nonce` names
 * no record is rejected. So a caller who can author the cookie (its value is a
 * bare hash of the nonce) still can't land a connection under an owner it
 * never authenticated as — the missing server record fails the flow closed.
 * This mirrors how `/v1/mcp-auth/callback` gates on `oauth-flow-registry`.
 *
 * Keyed by the 256-bit random `nonce` the initiate mints — unguessable, so
 * only the browser that ran an authenticated initiate holds a usable one.
 *
 * State is not persisted, for the same reasons as `oauth-flow-registry`:
 * connect flows complete in seconds and a process restart mid-flow is correctly
 * handled by re-initiating. The only intra-process concern is a leak — an
 * orphaned record (user closed the tab, network failure, never hit the callback)
 * — so every record carries a TTL and is reclaimed when it fires.
 *
 * Multi-replica: this map is per-pod, exactly like `oauth-flow-registry` and
 * `run-bus`. Today every tenant runs `platform.replicas: 1` (one pod per tenant,
 * the only supported topology), so the browser's return leg can't reach a
 * non-initiating pod. Under `replicas > 1` the tenant ingress's `lb_cookie`
 * session affinity (already configured, a no-op at one replica) pins a browser
 * to the pod that served `/initiate`, so the callback still resolves here;
 * moving to a shared (Redis) store to also survive a mid-flow pod restart is
 * deferred with the other `replicas > 1` prerequisites.
 */

import type { ConnectorOwner } from "../identity/connector-owner.ts";

interface PendingConnectFlow {
  owner: ConnectorOwner;
  connectorId: string;
  timeout: ReturnType<typeof setTimeout>;
}

const flows = new Map<string, PendingConnectFlow>();

/**
 * TTL for a pending connect flow. Long enough for a real interactive OAuth
 * round-trip at the vendor, short enough that an abandoned flow is reclaimed
 * quickly. Matches `oauth-flow-registry`'s window and is exported so tests can
 * target the boundary without a magic number.
 */
export const DEFAULT_CONNECT_FLOW_TTL_MS = 15 * 60 * 1000;

/** Record a pending connect flow keyed by `nonce`. Overwrites (and reclaims) any prior record for the same nonce. */
export function registerConnectFlow(
  nonce: string,
  owner: ConnectorOwner,
  connectorId: string,
  ttlMs: number = DEFAULT_CONNECT_FLOW_TTL_MS,
): void {
  // A fresh 256-bit nonce never collides in practice; clearing a pre-existing
  // record's timer is pure hygiene so a double-register can't leak a timer.
  const prev = flows.get(nonce);
  if (prev) clearTimeout(prev.timeout);

  const timeout = setTimeout(() => {
    // Only reclaim if this is still the same record — a consume that already
    // fired will have deleted it and cleared this timer.
    if (flows.get(nonce)?.timeout === timeout) flows.delete(nonce);
  }, ttlMs);
  // `unref` so an abandoned flow's timer can't keep a short-lived process
  // alive; a no-op in the long-running HTTP server.
  timeout.unref?.();

  flows.set(nonce, { owner, connectorId, timeout });
}

/**
 * Consume the pending flow for `nonce`: return its trusted `owner` +
 * `connectorId` and remove the record (one-shot). Returns null when no record
 * exists — the callback treats that as an unknown/expired flow and rejects.
 */
export function consumeConnectFlow(
  nonce: string,
): { owner: ConnectorOwner; connectorId: string } | null {
  const flow = flows.get(nonce);
  if (!flow) return null;
  flows.delete(nonce);
  clearTimeout(flow.timeout);
  return { owner: flow.owner, connectorId: flow.connectorId };
}

/** For tests: drop all pending flows. */
export function _clearAllConnectFlows(): void {
  for (const flow of flows.values()) clearTimeout(flow.timeout);
  flows.clear();
}
