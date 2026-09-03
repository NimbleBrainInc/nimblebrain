/**
 * Composio implementation of the kernel's `ConnectionHealthProbe`.
 *
 * A Composio connector authenticates the platform→Composio hop with a static
 * `x-api-key` (no OAuth provider), so the transport-level `UnauthorizedError`
 * path can't detect a lapsed connection — the downstream vendor account
 * (Microsoft, Google, …) expires while the platform's key stays valid. The only
 * signal is to ask Composio whether an ACTIVE connected account still exists for
 * this workspace's user + the connector's auth config.
 *
 * This adapter is the ONLY place that knows Composio specifics in the
 * re-validation path: it takes the stamped catalog id off the brokered ref,
 * resolves the auth config from the catalog, derives the Composio user id from
 * the workspace, and collapses Composio's four account statuses to the kernel's
 * three-valued verdict. The kernel (`ConnectionRevalidator`) sees only the
 * verdict.
 */

import { brokeredRef } from "../../../bundles/brokered.ts";
import type {
  ConnectionHealthProbe,
  ConnectionLiveness,
  ProbeTarget,
} from "../../../bundles/connection-probe.ts";
import { log } from "../../../observability/log.ts";
import type { ConnectorDirectory } from "../../../registries/directory.ts";
import { composioAuthConfigId, validateComposioConfig } from "./config.ts";
import { COMPOSIO_PROVIDER_ID } from "./id.ts";
import { composioUserId, findActiveComposioConnection } from "./sdk.ts";

export class ComposioConnectionProbe implements ConnectionHealthProbe {
  readonly providerId = COMPOSIO_PROVIDER_ID;

  constructor(private readonly directory: ConnectorDirectory) {}

  async probe(target: ProbeTarget, signal: AbortSignal): Promise<ConnectionLiveness> {
    if (signal.aborted) return "indeterminate";

    const connectorId = brokeredRef(target.ref)?.connectorId;
    if (!connectorId) return "indeterminate"; // dispatched here in error — not ours

    // Missing platform config can't distinguish "lost" from "can't check" —
    // treat as indeterminate so we never flip a healthy connection on a
    // deployment that hasn't wired the key/auth-config.
    const { apiKey } = validateComposioConfig();
    if (!apiKey) return "indeterminate";

    let authConfigId = "";
    try {
      const entry = await this.directory.catalogById(connectorId);
      authConfigId = entry?.composio ? composioAuthConfigId(entry.composio.toolkit) : "";
    } catch (err) {
      log.debug(
        "mcp",
        `[composio-probe] catalog lookup failed for ${connectorId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "indeterminate";
    }
    if (!authConfigId) return "indeterminate";

    const userId = composioUserId({ type: "workspace", wsId: target.wsId });
    try {
      // `findActiveComposioConnection` lists statuses:["ACTIVE"] and is bounded
      // by an internal 10s `withTimeout`. A non-null result = at least one
      // ACTIVE account = live. Null = no ACTIVE account (expired/revoked/none)
      // = the credential is gone.
      const active = await findActiveComposioConnection({ apiKey, userId, authConfigId });
      return active ? "live" : "credential_lost";
    } catch (err) {
      // Network error, timeout, rate limit, SDK shape change — never a flip.
      log.debug(
        "mcp",
        `[composio-probe] status check failed for ${target.serverName} (ws=${target.wsId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return "indeterminate";
    }
  }
}
