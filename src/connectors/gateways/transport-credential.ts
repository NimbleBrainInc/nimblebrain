/**
 * Gateway transport credentials — the bearer token an `auth: provider` catalog
 * entry authenticates a hosted-MCP gateway with.
 *
 * A **gateway** (MCP360, Glama) publishes fixed MCP endpoints and issues one
 * account-wide API key. It brokers nothing, so it implements no
 * `ManagedConnectorProvider`: there is no session to mint, no auth to broker, no
 * callback surface, and no per-connection state to probe. The only thing it
 * needs from the platform is the credential, which is exactly what the
 * `TransportCredentialProvider` seam is for.
 *
 * One implementation serves every gateway. The vendors differ only in their
 * endpoints, which their catalog entries already carry, and in their key, which
 * their config block carries — so a second gateway is a config edit rather than
 * a third near-identical vendor folder. That is the whole reason this is generic
 * where `providers/composio` and `providers/smithery` are not: those two differ
 * in *behavior* (Composio brokers OAuth and owns routes; Smithery brokers config
 * through a hosted setup page), and folding them together would have meant a
 * god-abstraction over genuinely different vendors. These two differ in a string.
 *
 * The invariant is the one phase 2.5 established and it is why the key is not in
 * the catalog entry: **persisted state names *what* credential it needs, never
 * *where* the value comes from.** An install copies `providerAuth.config`
 * verbatim into the `BundleRef`, so a `tokenEnv` field there would write an env
 * var name into tenant state — the shape that arrangement removed. The ref names
 * the gateway; resolution stays here.
 */

import { log } from "../../observability/log.ts";
import {
  registerCredentialProvider,
  type TransportCredential,
  type TransportCredentialProvider,
} from "../../tools/credential-provider.ts";
import { declaredGatewayConfigs, type GatewayConfig } from "../providers/config.ts";

/**
 * Credential-provider names a gateway may not claim.
 *
 * Registration is last-writer-wins over a name space shared with the built-ins,
 * and gateways register **last** (see `registerGatewayCredentialProviders`), so
 * a declared `connectors.gateways.composio` would otherwise replace the Composio
 * broker's credential with a static bearer and every Composio connector would
 * fail at its first tool call with a 401 that names nothing.
 *
 * **This set is the only thing preventing that.** Ordering does not help — it is
 * what creates the exposure — so a new built-in credential provider must be
 * added here in the same change that registers it. `gateway-credential.test.ts`
 * pins this list against the names the built-ins export, so adding one without
 * listing it here fails that test rather than shipping.
 */
const RESERVED_NAMES = new Set(["minted", "composio", "smithery"]);

/**
 * The env var a gateway's key falls back to: the name upper-cased with every
 * non-alphanumeric run collapsed to `_`. `mcp360` reads `MCP360_API_KEY`.
 */
export function gatewayApiKeyEnvVar(name: string): string {
  return `${name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}_API_KEY`;
}

/**
 * Resolve one gateway's key: the declared value, else its env var. A blank
 * declared value counts as absent, because a templated deploy renders an unset
 * value to `""` and that is not a declaration.
 */
function resolveApiKey(name: string, declared: GatewayConfig | undefined): string {
  return declared?.apiKey?.trim() || (process.env[gatewayApiKeyEnvVar(name)]?.trim() ?? "");
}

/**
 * Build the credential provider for one gateway.
 *
 * Workspace-independent by design: one account key serves the whole instance,
 * which is the defining limitation of this shape and the reason a broker beats
 * it where a vendor offers both. The gateway sees a single caller regardless of
 * which workspace made the call.
 *
 * Throws when the key is missing rather than attaching an empty bearer. A blank
 * `Authorization` is a silent 401 at the first tool call, which reads as "the
 * gateway is broken" instead of "you did not configure it".
 */
export function gatewayCredentialProvider(name: string): TransportCredentialProvider {
  return {
    credentialFor(): TransportCredential {
      const apiKey = resolveApiKey(name, declaredGatewayConfigs()?.[name]);
      if (!apiKey) {
        throw new Error(
          `[gateway:${name}] no API key configured; cannot authenticate a "${name}" connector. ` +
            `Set connectors.gateways.${name}.apiKey in nimblebrain.json or ` +
            `${gatewayApiKeyEnvVar(name)} in the platform env, then restart the API.`,
        );
      }
      return { headers: { Authorization: `Bearer ${apiKey}` } };
    },
  };
}

/**
 * Register a credential provider for every declared gateway.
 *
 * Runs at the composition root after `setConnectorsConfig`, which installs the
 * block this reads. That is the whole ordering constraint. Registering after the
 * built-ins and brokers is a consequence of it rather than a safety property:
 * last-writer-wins means this position is precisely the one where a gateway
 * could displace a built-in, which is why `RESERVED_NAMES` is a guard and not a
 * belt-and-braces second check.
 *
 * Registration is unconditional on the key resolving, matching the Smithery
 * arrangement: a gateway declared with no key still fails, and
 * `credentialFor`'s error names the cause better than the transport layer's
 * generic "provider not registered".
 */
export function registerGatewayCredentialProviders(): void {
  const declared = declaredGatewayConfigs();
  if (!declared) return;

  for (const name of Object.keys(declared)) {
    if (RESERVED_NAMES.has(name)) {
      log.warn(
        `[gateway:${name}] "${name}" is reserved by a built-in credential provider and was ` +
          "ignored. Rename the gateway in connectors.gateways.",
      );
      continue;
    }
    registerCredentialProvider(name, gatewayCredentialProvider(name));
    log.info(`[gateway:${name}] credential provider registered`);
  }
}
