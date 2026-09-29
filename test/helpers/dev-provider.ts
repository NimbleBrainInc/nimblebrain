import { DEV_IDENTITY, DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { IdentityStores } from "../../src/runtime/types.ts";
import { defaultWorkspaceFor, ensureUserWorkspace } from "../../src/workspace/provisioning.ts";

/**
 * The dev identity provider over the runtime's stores, for
 * `Runtime.start({ identityProvider: devProvider })`: every request is
 * `DEV_IDENTITY`. A test whose workDir has no `instance.json` chooses it here,
 * so the runtime (and the server serving it) authenticates with it.
 */
export function devProvider({ workDir, userStore }: IdentityStores): DevIdentityProvider {
  return new DevIdentityProvider(workDir, userStore);
}

/**
 * Run `fn` as the dev user, the identity the dev provider gives every request.
 * For a test that calls a tool source or registry directly, outside the HTTP
 * doors that would set the request context.
 */
export function asDevUser<T>(fn: () => T, workspaceId?: string): T {
  return runWithRequestContext(
    { identity: DEV_IDENTITY, ...(workspaceId !== undefined ? { workspaceId } : {}) },
    fn,
  );
}

/**
 * The dev user's workspace: the one bootstrap gives a user who belongs to none,
 * provisioned if needed, with its registry ready. The runtime never picks a
 * workspace for a request, so a test that drives it directly names this one.
 */
export async function devWorkspace(runtime: Runtime): Promise<string> {
  const store = runtime.getWorkspaceStore();
  const userStore = runtime.getUserStore();
  const memberships = await ensureUserWorkspace(
    store,
    { id: DEV_IDENTITY.id, displayName: DEV_IDENTITY.displayName },
    userStore,
  );
  const user = await userStore.get(DEV_IDENTITY.id);
  const wsId = defaultWorkspaceFor(memberships, user?.preferences).id;
  await runtime.ensureWorkspaceRegistry(wsId);
  return wsId;
}
