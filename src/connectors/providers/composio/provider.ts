/**
 * `ComposioProvider` — Composio as one registered `ManagedConnectorProvider`.
 *
 * This is the adapter that presents Composio's brokered-auth + hosted-session
 * capabilities through the vendor-neutral seam. Every method delegates to the
 * `sdk.ts` helpers (which lazy-load `@composio/core` on first call), so
 * constructing the provider — and holding it in the registry — links no vendor.
 * The vendor loads only when a brokered call actually runs.
 *
 * The platform-wide broker credential (`COMPOSIO_API_KEY`) is Composio's own
 * detail: it is resolved from the env here and injected into the underlying
 * helpers, never threaded through the seam's opts. Per-connector data
 * (`authConfigId`, `toolkit`, `fields`) and the owner-derived `userId` are the
 * only things callers pass.
 */

import { composioAuthRoutes } from "../../../api/routes/composio-auth.ts";
import type { AppContext } from "../../../api/types.ts";
import { log } from "../../../observability/log.ts";
import type { ManagedConnectorProvider } from "../managed-provider.ts";
import { ComposioConnectionProbe } from "./connection-probe.ts";
import { composioMonitorEnabled } from "./monitor-config.ts";
import {
  composioUserId,
  connectComposioApiKey,
  createComposioSession,
  deleteComposioConnectedAccount,
  findActiveComposioConnection,
  initiateComposioConnection,
} from "./sdk.ts";

/** The platform-wide Composio broker credential. Present by construction — the provider is built only when configured. */
function envApiKey(): string {
  return (process.env.COMPOSIO_API_KEY ?? "").trim();
}

/**
 * Build the Composio `ManagedConnectorProvider`. Called only when Composio is
 * configured (`buildManagedConnectorRegistry`), so `COMPOSIO_API_KEY` is set.
 * Reads the monitor kill switch once here — the same "read env once at startup"
 * contract the rest of the Composio config follows.
 */
export function createComposioProvider(): ManagedConnectorProvider {
  // The revalidator probe is Composio's, and the operator can disable JUST the
  // liveness sweep (COMPOSIO_MONITOR_ENABLED=false) without disabling the
  // connector's auth/session brokering. When thrown, omit `probe` entirely so
  // the runtime wires no probe for this provider — keeping the revalidator
  // wiring in `server.ts` fully provider-agnostic.
  const monitorEnabled = composioMonitorEnabled(true);
  if (!monitorEnabled) {
    log.info("[connection-revalidator] disabled via COMPOSIO_MONITOR_ENABLED=false");
  }

  return {
    id: "composio",

    userId: composioUserId,

    createSession: (opts) => createComposioSession({ apiKey: envApiKey(), ...opts }),

    initiate: (opts) => initiateComposioConnection({ apiKey: envApiKey(), ...opts }),

    connectApiKey: (opts) => connectComposioApiKey({ apiKey: envApiKey(), ...opts }),

    findActive: (opts) => findActiveComposioConnection({ apiKey: envApiKey(), ...opts }),

    delete: (connectedAccountId) =>
      deleteComposioConnectedAccount({ apiKey: envApiKey(), connectedAccountId }),

    ...(monitorEnabled ? { probe: (directory) => new ComposioConnectionProbe(directory) } : {}),

    routes: (ctx: AppContext) => composioAuthRoutes(ctx),
  };
}
