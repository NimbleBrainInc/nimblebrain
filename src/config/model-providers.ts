/**
 * The hosted model providers the environment configures.
 *
 * A Docker install's only channel from the installer to the runtime is its
 * `.env`, which Compose passes through: `npx nimblebrain` writes a provider's
 * key there, never a `providers` block. So when the config file names no
 * providers, each provider whose key variable is set (`MODEL_PROVIDER_KEY_ENV`)
 * is configured from the environment. A `providers` block in the file is the
 * whole set: a key in the environment for a provider it does not name
 * configures nothing, which is what keeps a local-only install local.
 */

import { MODEL_PROVIDER_KEY_ENV } from "../model/registry.ts";

interface ProvidersSource {
  providers?: Record<string, unknown>;
  execution?: { modelGateway?: string };
}

/**
 * The `providers` the environment implies, or `undefined` when the file names
 * its own or the installation's model gateway reaches every provider. May be
 * empty: no provider is assumed.
 */
export function providersFromEnv(
  config: ProvidersSource,
  env: Record<string, string | undefined>,
): Record<string, Record<string, never>> | undefined {
  if (config.providers || config.execution?.modelGateway) return undefined;
  const providers: Record<string, Record<string, never>> = {};
  for (const [id, variable] of Object.entries(MODEL_PROVIDER_KEY_ENV)) {
    if (env[variable]?.trim()) providers[id] = {};
  }
  return providers;
}
