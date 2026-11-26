/**
 * Process-local registry for pending Composio connect flows.
 *
 * A record is created at a Composio initiate route — behind `requireAuth`,
 * with the owner derived from the authenticated session — and consumed once at
 * the unauthenticated `/v1/composio-auth/callback` (the return leg from the
 * vendor). The record holds everything the callback lands: the owner, the
 * connector, and the connected account Composio created at initiate. The
 * callback takes none of these from its query. It also holds the hash of the
 * browser binding the initiate set as the `nb_composio_state` cookie
 * (`src/oauth/flow-binding.ts`), so only the browser that ran the initiate
 * completes the flow.
 *
 * Keyed by the 256-bit random `nonce` the initiate mints. The nonce rides in
 * the callback URL, so it is a lookup key, not a credential.
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
 * deferred with the rest of what blocks more than one replica (`src/api/AGENTS.md`).
 */

import type { ConnectorOwner } from "../../../identity/connector-owner.ts";

/** What an authenticated initiate records for its callback to land. */
export interface ConnectFlow {
  owner: ConnectorOwner;
  connectorId: string;
  /** The connected account Composio created for this flow at initiate; the one the callback persists. */
  connectedAccountId: string;
  /** sha256 of the browser binding the initiate set as the flow's cookie. */
  bindingHash: string;
  /** The workspace a personal connect was started from, to return to. */
  returnWsId?: string;
  /** The caller's conversation in `returnWsId` to reopen on return, checked by the initiate. */
  returnConversationId?: string;
}

interface PendingConnectFlow extends ConnectFlow {
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
  flow: ConnectFlow,
  options: { ttlMs?: number } = {},
): void {
  const ttlMs = options.ttlMs ?? DEFAULT_CONNECT_FLOW_TTL_MS;
  const { returnWsId, returnConversationId } = flow;
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

  flows.set(nonce, {
    owner: flow.owner,
    connectorId: flow.connectorId,
    connectedAccountId: flow.connectedAccountId,
    bindingHash: flow.bindingHash,
    timeout,
    ...(returnWsId ? { returnWsId } : {}),
    ...(returnWsId && returnConversationId ? { returnConversationId } : {}),
  });
}

/**
 * Read the pending flow for `nonce` without removing it, or null when none is
 * pending. The callback checks the browser binding against it first, so a
 * request from another browser cannot end someone else's flow.
 */
export function peekConnectFlow(nonce: string): ConnectFlow | null {
  const flow = flows.get(nonce);
  return flow ? publicFlow(flow) : null;
}

/**
 * Consume the pending flow for `nonce`: return what its initiate recorded and
 * remove the record (one-shot). Returns null when no record exists — the
 * callback treats that as an unknown/expired flow and rejects.
 */
export function consumeConnectFlow(nonce: string): ConnectFlow | null {
  const flow = flows.get(nonce);
  if (!flow) return null;
  flows.delete(nonce);
  clearTimeout(flow.timeout);
  return publicFlow(flow);
}

function publicFlow(flow: PendingConnectFlow): ConnectFlow {
  const { owner, connectorId, connectedAccountId, bindingHash, returnWsId, returnConversationId } =
    flow;
  return {
    owner,
    connectorId,
    connectedAccountId,
    bindingHash,
    ...(returnWsId ? { returnWsId } : {}),
    ...(returnConversationId ? { returnConversationId } : {}),
  };
}

/** For tests: drop all pending flows. */
export function _clearAllConnectFlows(): void {
  for (const flow of flows.values()) clearTimeout(flow.timeout);
  flows.clear();
}
