/**
 * Provider-agnostic connection credential re-validation.
 *
 * Some connectors' upstream authorization can lapse WITHOUT the transport ever
 * seeing a 401: a managed-MCP provider (e.g. Composio) authenticates the
 * platform→provider hop with a key that stays valid while the *downstream*
 * vendor account (Microsoft, Google, …) expires. The transport-level
 * `UnauthorizedError` path (`McpSource.execute` → provider `notifyAuthLost`)
 * cannot see that. The only signal is to ASK the provider, out of band.
 *
 * This module is the kernel's generic seam for that: the `ConnectionRevalidator`
 * polls `running` connections and asks each one's provider probe "is your
 * upstream credential still live?". The kernel owns *when and over what* to
 * poll and how to map the verdict to connection state; the probe (an adapter,
 * not the kernel) owns *how to ask this vendor*.
 *
 * The PROBE is genuinely pluggable, and so is what it dispatches on: a probe is
 * selected by the `provider` on the install's `brokered` ref (`./brokered.ts`),
 * which is a registered provider id, not a member of a closed enum. Adding a
 * provider adds a folder under `src/connectors/providers/` and a line in the
 * registry builder; nothing here changes.
 */

import type { BundleRef } from "./types.ts";

/**
 * Provider-agnostic liveness verdict for an established connection's upstream
 * credential. The kernel maps this to `ConnectionState`; a probe never names a
 * `ConnectionState` or a vendor concept.
 *
 *   - `live`           — upstream credential is valid.
 *   - `credential_lost`— upstream is definitively gone (expired / revoked /
 *                        no active account). The kernel counts this toward the
 *                        flip threshold.
 *   - `indeterminate`  — couldn't tell (network error, timeout, missing config).
 *                        The kernel changes nothing — the anti-flap fail-safe.
 */
export type ConnectionLiveness = "live" | "credential_lost" | "indeterminate";

/**
 * What the kernel hands a probe: the connection identity it owns, nothing
 * provider-shaped. `ref` is the bundle's kernel install reference — a probe
 * reads it through `brokeredRef()` and takes only the `connectorId` and its own
 * opaque `providerRef` from the result. Carrying the ref keeps the probe from
 * having to call back into the lifecycle to recover vendor specifics.
 */
export interface ProbeTarget {
  readonly serverName: string;
  readonly wsId: string;
  readonly principalId: string;
  readonly ref: BundleRef;
}

/**
 * Implemented by an adapter that can independently verify whether a `running`
 * connection's upstream authorization is still valid — out of band from the
 * transport. One probe per provider.
 */
export interface ConnectionHealthProbe {
  /** Stable provider id this probe answers for — the same id its
   *  `ManagedConnectorProvider` registers under, which is what a brokered ref's
   *  `provider` field names. For dispatch + logs only; the revalidator never
   *  branches on its value. */
  readonly providerId: string;
  /**
   * Check one connection's upstream credential. MUST NOT throw — map any
   * network / timeout / API / config error to `indeterminate`. Should honor
   * the abort signal (the sweep is cancellable).
   */
  probe(target: ProbeTarget, signal: AbortSignal): Promise<ConnectionLiveness>;
}
