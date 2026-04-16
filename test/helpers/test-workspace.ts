import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";

/**
 * Default workspace ID for integration tests.
 * Tests must explicitly create and provision workspaces — there is no implicit
 * dev-mode fallback. This constant standardizes the ID used across tests.
 */
export const TEST_WORKSPACE_ID = "ws_test";

/**
 * Provision a workspace for integration tests.
 * Creates the workspace in the store, ensures a registry exists, and adds
 * the dev user (usr_default) as a member so that DevIdentityProvider-based
 * API requests resolve to this workspace automatically.
 * Idempotent — safe to call multiple times with the same wsId.
 */
export async function provisionTestWorkspace(
  runtime: Runtime,
  wsId: string = TEST_WORKSPACE_ID,
  name: string = "Test Workspace",
): Promise<string> {
  const wsStore = runtime.getWorkspaceStore();
  const existing = await wsStore.get(wsId);
  if (!existing) {
    // Strip the ws_ prefix to get the slug — WorkspaceStore.create prefixes it back
    const slug = wsId.startsWith("ws_") ? wsId.slice(3) : wsId;
    const ws = await wsStore.create(name, slug);
    await wsStore.addMember(ws.id, DEV_IDENTITY.id, "admin");
  }
  await runtime.ensureWorkspaceRegistry(wsId);
  return wsId;
}
