import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { UserStore } from "../../src/identity/user.ts";

/**
 * The dev identity provider over a test workDir, for
 * `Runtime.start({ identityProvider })`: every request is `DEV_IDENTITY`. A
 * test whose workDir has no `instance.json` chooses it here, so the runtime
 * (and the server serving it) authenticates with it.
 */
export function devProvider(workDir: string): DevIdentityProvider {
  return new DevIdentityProvider(workDir, new UserStore(workDir));
}
