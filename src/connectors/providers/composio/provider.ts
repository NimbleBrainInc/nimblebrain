/**
 * `ComposioProvider` — Composio as one registered `ManagedConnectorProvider`.
 *
 * This is the adapter that presents Composio's brokered-auth + hosted-session
 * capabilities through the vendor-neutral seam. Every method delegates to the
 * `sdk.ts` helpers (which lazy-load `@composio/core` on first call), so
 * constructing the provider — and holding it in the registry — links no vendor.
 * The vendor loads only when a brokered call actually runs.
 *
 * The platform-wide broker credential is Composio's own detail: it is resolved
 * from the provider config here and injected into the underlying helpers, never
 * threaded through the seam's opts. Per-connector data (`authConfigId`,
 * `toolkit`, `fields`) and the owner-derived `userId` are the only things
 * callers pass.
 */

import { composioAuthRoutes } from "../../../api/routes/composio-auth.ts";
import type { AppContext } from "../../../api/types.ts";
import { log } from "../../../observability/log.ts";
import type { ManagedConnectorProvider } from "../managed-provider.ts";
import { validateComposioConfig } from "./config.ts";
import { ComposioConnectionProbe } from "./connection-probe.ts";
import {
  composioUserId,
  connectComposioApiKey,
  createComposioSession,
  deleteComposioConnectedAccount,
  findActiveComposioConnection,
  initiateComposioConnection,
} from "./sdk.ts";

/** The platform-wide Composio broker credential. Present by construction — the provider is built only when configured. */
function brokerApiKey(): string {
  return validateComposioConfig().apiKey;
}

/**
 * Build the Composio `ManagedConnectorProvider`. Called only when Composio is
 * configured (`buildManagedConnectorRegistry`), so the broker credential is
 * present. Reads the monitor switch once here — the same "resolve config once at
 * startup" contract the rest of the Composio config follows.
 */
export function createComposioProvider(): ManagedConnectorProvider {
  // The revalidator probe is Composio's, and the operator can disable JUST the
  // liveness sweep without disabling the connector's auth/session brokering.
  // When thrown, omit `probe` entirely so the runtime wires no probe for this
  // provider — keeping the revalidator wiring in `server.ts` fully
  // provider-agnostic.
  const { monitorEnabled } = validateComposioConfig();
  if (!monitorEnabled) {
    log.info(
      "[connection-revalidator] composio probe disabled " +
        "(connectors.providers.composio.monitorEnabled)",
    );
  }

  return {
    id: "composio",

    userId: composioUserId,

    // `authConfigId` is optional at the seam (a provider that keys a session on
    // a server slug alone has no auth-config concept). Composio DOES require
    // one — every session binds a toolkit to an auth config — so it asserts that
    // here, at its own boundary, rather than the seam demanding it of everyone.
    // `async` so the rejection is a rejected promise, not a synchronous throw:
    // the seam declares `Promise<ManagedSession>`, and a caller that chains
    // `.catch()` instead of `await`-ing inside a try would otherwise be hit by
    // an exception the type says cannot happen.
    createSession: async (opts) => {
      const authConfigId = opts.authConfigId?.trim();
      if (!authConfigId) {
        throw new Error(`Composio session for toolkit "${opts.toolkit}" requires an authConfigId.`);
      }
      return createComposioSession({ apiKey: brokerApiKey(), ...opts, authConfigId });
    },

    initiate: (opts) => initiateComposioConnection({ apiKey: brokerApiKey(), ...opts }),

    connectApiKey: (opts) => connectComposioApiKey({ apiKey: brokerApiKey(), ...opts }),

    findActive: (opts) => findActiveComposioConnection({ apiKey: brokerApiKey(), ...opts }),

    delete: (connectedAccountId) =>
      deleteComposioConnectedAccount({ apiKey: brokerApiKey(), connectedAccountId }),

    ...(monitorEnabled ? { probe: (directory) => new ComposioConnectionProbe(directory) } : {}),

    routes: (ctx: AppContext) => composioAuthRoutes(ctx),
  };
}
