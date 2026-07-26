import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { hasMcpOAuthTokens } from "../tools/workspace-oauth-provider.ts";
import { hasPersistedComposioConnection } from "./composio-connection.ts";
import { brokeredRef } from "./connection-probe.ts";
import type { BundleRef } from "./types.ts";

/**
 * Whether a connector already holds a credential on disk.
 *
 * Existence only, never validity — the contract `hasMcpOAuthTokens` and
 * `hasPersistedComposioConnection` document. Two things depend on this answer
 * and must not disagree: the re-connect gate on both auth-initiate routes, and
 * the `hasCredential` the UI reads to decide whether to offer the CTA at all.
 *
 * **Keyed on the stored ref, never the catalog.** The ref is what the Connect
 * route itself keys on, and it survives a catalog entry being renamed, removed,
 * or a registry fetch failing — all of which leave `resolveInstanceCatalog`
 * returning undefined. Discriminating on the catalog instead means a brokered
 * connector silently probes the DCR layout, finds nothing, and reports "no
 * credential" — which reads as a first connect and skips the gate entirely.
 * `handleListPersonalConnectors` keys on the ref for exactly this reason.
 *
 * Brokered providers (composio, smithery) keep a connected account under their
 * own connector id; everything else keeps OAuth tokens under the server name.
 * A provider with no persisted-credential layout of its own answers `false`,
 * which is correct: there is nothing to replace, so nothing to gate.
 */
export function connectorHasCredential(
  workDir: string,
  owner: ConnectorOwner,
  serverName: string,
  ref: BundleRef | undefined,
): boolean {
  const brokered = brokeredRef(ref);
  if (brokered?.providerId === "composio") {
    return hasPersistedComposioConnection(workDir, owner, brokered.connectorId);
  }
  if (brokered) return false;
  return hasMcpOAuthTokens(workDir, owner, serverName);
}
