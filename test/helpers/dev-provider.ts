import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import type { IdentityStores } from "../../src/runtime/types.ts";

/**
 * The dev identity provider over the runtime's stores, for
 * `Runtime.start({ identityProvider: devProvider })`: every request is
 * `DEV_IDENTITY`. A test whose workDir has no `instance.json` chooses it here,
 * so the runtime (and the server serving it) authenticates with it.
 */
export function devProvider({ workDir, userStore }: IdentityStores): DevIdentityProvider {
  return new DevIdentityProvider(workDir, userStore);
}
