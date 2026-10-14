/**
 * Composio's transport credential — the `x-api-key` a connector's remote MCP
 * session authenticates with.
 *
 * **The invariant this exists to hold: persisted state names *what* credential
 * it needs, never *where* the value comes from.** A Composio-installed ref
 * carries `auth: { type: "provider", provider: "composio" }`; where the key
 * actually lives (the declared `connectors.providers.composio` block, or the env
 * fallback) is `config.ts`'s private business, invisible to persisted state, to
 * the transport layer, and to the schema. That is what lets the broker
 * credential be declared in `nimblebrain.json`, and what keeps a second brokered
 * provider from minting its own env name in tenant state.
 *
 * This is the kernel's generic seam for machine-plane credentials
 * (`src/tools/credential-provider.ts`), the same one `minted` uses.
 */

import {
  registerCredentialProvider,
  type TransportCredential,
  type TransportCredentialProvider,
} from "../../../tools/credential-provider.ts";
import { validateComposioConfig } from "./config.ts";
import { COMPOSIO_PROVIDER_ID } from "./id.ts";

/** The credential-provider name a Composio-installed ref selects. */
export const COMPOSIO_CREDENTIAL_PROVIDER = COMPOSIO_PROVIDER_ID;

/** The header a Composio hosted-session endpoint authenticates on. */
const COMPOSIO_AUTH_HEADER = "x-api-key";

/**
 * Attaches the platform-wide broker credential. Workspace-independent by
 * design: one Composio account serves the whole tenant, and per-owner isolation
 * lives in the Composio-side `user_id`, not in the credential.
 *
 * Throws when Composio is unconfigured rather than attaching an empty header —
 * a blank `x-api-key` is a silent 401 at first tool call, which is the failure
 * mode this seam exists to remove. Registration is unconditional (see below), so
 * this is the gate, and it names the cause at source start.
 */
export const composioCredentialProvider: TransportCredentialProvider = {
  credentialFor(): TransportCredential {
    const { apiKey } = validateComposioConfig();
    if (!apiKey) {
      throw new Error(
        "[composio] no broker credential configured; cannot authenticate a Composio " +
          "connector's session. Set connectors.providers.composio.apiKey in nimblebrain.json " +
          "(or COMPOSIO_API_KEY in the platform env) and restart the API.",
      );
    }
    return { headers: { [COMPOSIO_AUTH_HEADER]: apiKey } };
  },
};

/**
 * Register the credential provider at the composition root.
 *
 * Must run before `startWorkspaceConnectors`: a connected Composio connector starts
 * at boot, and `applyProviderAuth` throws for an unregistered name — which would
 * drop the source from the registry and take the connector's tools down on every
 * restart. Registering from the provider factory instead is too late, because the
 * managed-connector registry is built lazily, after `Runtime.start` returns.
 *
 * Unconditional by design. Gating on "is Composio configured" would buy nothing:
 * a ref naming this provider on a Composio-less deploy still fails, and
 * `credentialFor`'s error ("no broker credential configured") names the cause
 * better than the registry's generic "provider not registered".
 */
export function registerComposioCredentialProvider(): void {
  registerCredentialProvider(COMPOSIO_CREDENTIAL_PROVIDER, composioCredentialProvider);
}
