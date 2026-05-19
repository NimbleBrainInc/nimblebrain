import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";

/**
 * Default workspace ID for integration tests.
 * Tests must explicitly create and provision workspaces — there is no implicit
 * dev-mode fallback. This constant standardizes the ID used across tests.
 */
export const TEST_WORKSPACE_ID = "ws_test";

/**
 * Construct a `WorkspaceContext` for unit tests that don't have a full
 * `Runtime` available. Produces the same `WorkspaceContext` instance
 * type as `Runtime.getWorkspaceContext(wsId)`, but the signature
 * intentionally differs: the runtime form takes only `wsId` (the
 * runtime owns the workDir), while this helper takes `(workDir, wsId)`
 * so tests can point at a `mkdtempSync(...)` directory without
 * bootstrapping the whole platform.
 *
 * Use this anywhere a test fixture previously passed `(wsId, workDir)`
 * pairs to free functions — the resulting context is the same
 * production code uses today.
 */
export function makeTestWorkspaceContext(
  workDir: string,
  wsId: string = TEST_WORKSPACE_ID,
): WorkspaceContext {
  return new WorkspaceContext({ wsId, workDir });
}

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
