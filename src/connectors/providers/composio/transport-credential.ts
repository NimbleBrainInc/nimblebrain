/**
 * Composio's transport credential — the `x-api-key` a connector's remote MCP
 * session authenticates with.
 *
 * **The invariant this exists to hold: persisted state names *what* credential
 * it needs, never *where* the value comes from.**
 *
 * A Composio install used to persist the literal string `${COMPOSIO_API_KEY}`
 * into its `BundleRef` transport headers, resolved from `process.env` at
 * transport-build time by a generic env-template expansion. That kept the secret
 * out of `workspace.json` — the goal — but it did so by writing a durable
 * *pointer into the environment namespace* into tenant state. The consequences
 * were structural, not cosmetic: the broker credential could not be declared in
 * `nimblebrain.json` (installed connectors would have authenticated with an empty
 * header), and a second brokered provider would have had to mint its own
 * hardcoded env name in tenant state to match.
 *
 * A ref now names this provider instead — `auth: { type: "provider", provider:
 * "composio" }` — and resolution becomes `config.ts`'s private business. Where
 * the value actually lives (declared block, env fallback) stops being visible to
 * persisted state, to the transport layer, and to the schema.
 *
 * This is the kernel's existing generic seam for machine-plane credentials
 * (`src/tools/credential-provider.ts`), the same one `minted` uses. The env
 * template was a second, weaker mechanism competing with it.
 */

import type { RemoteTransportConfig } from "../../../bundles/types.ts";
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
 * The env reference legacy installs persisted. Refs written before the provider
 * seam carry this verbatim; {@link composioTransportConfig} maps them forward on
 * read so no migration script or maintenance window is needed.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal legacy placeholder, matched not interpolated
const LEGACY_ENV_TEMPLATE = "${COMPOSIO_API_KEY}";

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
 * Must run before `startWorkspaceBundles`: a connected Composio connector starts
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

/** Whether `auth` is the pre-seam `x-api-key: ${COMPOSIO_API_KEY}` header form. */
function isLegacyEnvTemplateAuth(auth: RemoteTransportConfig["auth"]): boolean {
  return (
    auth?.type === "header" &&
    auth.name?.toLowerCase() === COMPOSIO_AUTH_HEADER &&
    auth.value === LEGACY_ENV_TEMPLATE
  );
}

/**
 * Map a Composio ref's persisted transport config forward to provider auth.
 *
 * Read-path normalization, deliberately: it is idempotent, needs no operator
 * action, and leaves `workspace.json` untouched — a ref written before the seam
 * behaves identically to one written after it, including on a deploy whose
 * broker credential now lives in `nimblebrain.json` rather than the env. Once no
 * legacy refs remain in the field this collapses to the identity function and can
 * be deleted — tracked in #756.
 *
 * Returns `config` unchanged for every other shape, so a non-Composio ref and an
 * already-migrated one both pass straight through.
 *
 * **Scope: `auth` only, not `headers`.** The pre-seam scrub rewrote any *other*
 * response header embedding the key into a `${COMPOSIO_API_KEY}` template too.
 * Nothing expands `${VAR}` in a header any more, so such a header would now be
 * sent verbatim — a literal `${COMPOSIO_API_KEY}` the vendor rejects. Left
 * unmapped deliberately: no such ref exists (Composio returns only
 * `x-api-key`), and it fails loudly at the vendor rather than silently.
 * `provider.ts`'s `scrubSessionHeaders` keeps its drop branch because writing a
 * key-bearing header would put a secret at rest. If one is ever found in the
 * field, drop it here rather than resolving it — that is what a fresh install
 * now does.
 */
export function composioTransportConfig(
  config: RemoteTransportConfig | undefined,
): RemoteTransportConfig | undefined {
  if (!config || !isLegacyEnvTemplateAuth(config.auth)) return config;
  return {
    ...config,
    auth: { type: "provider", provider: COMPOSIO_CREDENTIAL_PROVIDER, config: {} },
  };
}
