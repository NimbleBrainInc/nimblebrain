/**
 * Smithery's transport credential — the bearer token a connector's brokered MCP
 * session authenticates with.
 *
 * Sibling of `providers/composio/transport-credential.ts`, holding the same
 * invariant for the same reason: **persisted state names *what* credential it
 * needs, never *where* the value comes from.**
 *
 * Provider #2 is where that invariant gets tested. Matching Composio's pre-seam
 * shape would have meant persisting `Bearer ${SMITHERY_API_KEY}` into tenant
 * state — a second hardcoded env name on disk, and the difference between a seam
 * and Composio-with-indirection. Naming the provider instead means a ref carries
 * `auth: { type: "provider", provider: "smithery" }` and resolution stays
 * `config.ts`'s private business, so the broker credential can join the declared
 * `connectors.providers.smithery` block exactly like Composio's `apiKey` did.
 *
 * No legacy-mapping arm here, deliberately: `smithery` refs did not exist before
 * this seam, so there is no pre-provider shape in the field to normalize on read.
 * The moment one could exist is the moment this file would need Composio's
 * `smitheryTransportConfig` counterpart.
 */

import {
  registerCredentialProvider,
  type TransportCredential,
  type TransportCredentialProvider,
} from "../../../tools/credential-provider.ts";
import { validateSmitheryConfig } from "./config.ts";
import { SMITHERY_PROVIDER_ID } from "./id.ts";

/** The credential-provider name a Smithery-installed ref selects. */
export const SMITHERY_CREDENTIAL_PROVIDER = SMITHERY_PROVIDER_ID;

/**
 * Attaches the platform-wide broker credential. Workspace-independent by design:
 * one Smithery account serves the whole tenant, and per-owner isolation lives in
 * the connection id and its `metadata.userId`, not in the credential.
 *
 * Throws when Smithery is unconfigured rather than attaching an empty bearer — a
 * blank `Authorization` is a silent 401 at first tool call, which is the failure
 * mode this seam exists to remove.
 */
export const smitheryCredentialProvider: TransportCredentialProvider = {
  credentialFor(): TransportCredential {
    const { apiKey } = validateSmitheryConfig();
    if (!apiKey) {
      throw new Error(
        "[smithery] no broker credential configured; cannot authenticate a Smithery " +
          "connector's session. Set SMITHERY_API_KEY in the platform env and restart the API.",
      );
    }
    return { headers: { Authorization: `Bearer ${apiKey}` } };
  },
};

/**
 * Register the credential provider at the composition root, for the same reason
 * Composio's is registered there: a connected connector starts at boot, and
 * `applyProviderAuth` throws for an unregistered name — which would drop the
 * source and take the connector's tools down on every restart. The managed-
 * connector registry is built lazily, after `Runtime.start` returns, so
 * registering from the provider factory would be too late.
 *
 * Unconditional, like Composio's: gating on "is Smithery configured" buys
 * nothing, because a ref naming this provider on a Smithery-less deploy still
 * fails, and `credentialFor`'s error names the cause better than the registry's
 * generic "provider not registered".
 */
export function registerSmitheryCredentialProvider(): void {
  registerCredentialProvider(SMITHERY_CREDENTIAL_PROVIDER, smitheryCredentialProvider);
}
