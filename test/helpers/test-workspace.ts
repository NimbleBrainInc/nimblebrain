import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
 * Creates the workspace in the store, seats `memberIds` as admins, and
 * ensures a registry exists. The default seats the dev user (usr_default), the
 * identity DevIdentityProvider authenticates as; a test that authenticates
 * through TestAuthAdapter passes `[TEST_IDENTITY.id]`. Neither identity
 * provider seats anyone, so the members named here are the only ones.
 * Idempotent — safe to call multiple times with the same wsId; members are
 * seated only when the call creates the workspace.
 */
export async function provisionTestWorkspace(
  runtime: Runtime,
  wsId: string = TEST_WORKSPACE_ID,
  name: string = "Test Workspace",
  memberIds: readonly string[] = [DEV_IDENTITY.id],
): Promise<string> {
  const wsStore = runtime.getWorkspaceStore();
  const existing = await wsStore.get(wsId);
  if (!existing) {
    // Strip the ws_ prefix to get the slug — WorkspaceStore.create prefixes it back
    const slug = wsId.startsWith("ws_") ? wsId.slice(3) : wsId;
    const ws = await wsStore.create(name, slug);
    for (const userId of memberIds) await wsStore.addMember(ws.id, userId, "admin");
  }
  await runtime.ensureWorkspaceRegistry(wsId);
  return wsId;
}

/**
 * Create `{workDir}/workspaces/<wsId>/` — the workspace root a store's first
 * write requires.
 *
 * A workspace-scoped store creates its own subdirectory on first write, but
 * only *inside* a live root: `ensureWorkspaceDir` refuses to create the root
 * itself, because a writer doing so is how a deleted workspace came back. A
 * unit test that points a store at a bare `mkdtempSync` dir therefore has to
 * stand the root up, exactly as `WorkspaceStore.create` would.
 *
 * Returns the root path. Idempotent.
 */
export function seedWorkspaceRoot(workDir: string, wsId: string = TEST_WORKSPACE_ID): string {
  const root = join(workDir, "workspaces", wsId);
  mkdirSync(root, { recursive: true });
  return root;
}
