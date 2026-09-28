import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";

/**
 * The dev identity provider over a test runtime's stores, for `startServer`
 * when the test's workDir has no `instance.json`: every request is
 * `DEV_IDENTITY`. The server never picks this itself, so a test that wants
 * it says so.
 */
export function devProvider(runtime: Runtime): DevIdentityProvider {
  return new DevIdentityProvider(runtime.getWorkDir(), runtime.getUserStore());
}
