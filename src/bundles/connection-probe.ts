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
 * The PROBE is genuinely pluggable — Composio and Smithery both implement this
 * interface without the revalidator changing. The `auth-kind` taxonomy it
 * dispatches on is not: adding a provider still means teaching an open-coded
 * enum in a dozen places across the kernel (see `brokeredRef` below).
 * Don't read "generic seam" as "drop-in".
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
 * reads only its OWN provider's sub-field from it (the Composio probe reads
 * `ref.composio.connectorId`). Carrying the ref keeps the probe from having to
 * call back into the lifecycle to recover vendor specifics.
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
  /** Stable provider id this probe answers for. For dispatch + logs only; the
   *  revalidator never branches on its value. Must match `brokeredRef`. */
  readonly providerId: string;
  /**
   * Check one connection's upstream credential. MUST NOT throw — map any
   * network / timeout / API / config error to `indeterminate`. Should honor
   * the abort signal (the sweep is cancellable).
   */
  probe(target: ProbeTarget, signal: AbortSignal): Promise<ConnectionLiveness>;
}

/**
 * Map a bundle's install ref to the brokered provider that owns it, and to the
 * catalog id that provider stamped at install.
 *
 * ONE enumeration of the brokered kinds, deliberately. Two consumers need
 * different halves of the same fact — the revalidator dispatches on
 * `providerId`, while the connector read surfaces and the skill-overlay
 * reconcile resolve `connectorId` (every brokered install persists a per-install
 * session URL, so a url→catalog lookup misses and the stamped id is the only way
 * back to the entry). Splitting them into two functions meant two provider lists
 * to keep in sync by hand, and a third provider added to one but not the other
 * silently loses either probe dispatch or catalog resolution.
 *
 * Returns null for a runtime-native ref (plain OAuth or stdio) — those use the
 * transport-level `UnauthorizedError` path and resolve their catalog entry by
 * URL, so neither consumer needs anything here.
 */
export interface BrokeredRef {
  /** Stable provider id, for probe dispatch and logs. */
  providerId: string;
  /** The catalog entry id the install stamped on the ref. */
  connectorId: string;
}

export function brokeredRef(ref: BundleRef | undefined): BrokeredRef | null {
  if (!ref) return null;
  if ("composio" in ref && ref.composio) {
    return { providerId: "composio", connectorId: ref.composio.connectorId };
  }
  if ("smithery" in ref && ref.smithery) {
    return { providerId: "smithery", connectorId: ref.smithery.connectorId };
  }
  return null;
}
