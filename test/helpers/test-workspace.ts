import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { writeJsonAtomic } from "../../src/util/atomic-json.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";
import { scaffoldWorkspace } from "../../src/workspace/scaffold.ts";
import type { Workspace, WorkspaceMember } from "../../src/workspace/types.ts";
import { WORKSPACE_ID_RE } from "../../src/workspace/workspace-id-pattern.ts";
import {
  WorkspaceConflictError,
  type WorkspaceStore,
} from "../../src/workspace/workspace-store.ts";

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
 * Place a workspace with a chosen id on disk, as one that already exists.
 *
 * `WorkspaceStore.create` only mints generated ids, so a fixture that needs a
 * stable id — a constant shared across a file, a tool name built from it —
 * seeds the record the store loads instead: `workspace.json` plus the scaffold
 * `create` lays down. This is the load path, the one existing workspaces take
 * at boot, so the id must satisfy the loading pattern (`WORKSPACE_ID_RE`), not
 * the generated one. Members are seated through `addMember`, so membership-
 * change subscribers fire as they would for a create.
 *
 * Throws `WorkspaceConflictError` when the id is taken, like `create`.
 */
export async function seedWorkspace(
  store: WorkspaceStore,
  id: string,
  opts: { name?: string; about?: string | null; members?: readonly WorkspaceMember[] } = {},
): Promise<Workspace> {
  if (!WORKSPACE_ID_RE.test(id)) throw new Error(`seedWorkspace: invalid workspace id "${id}"`);
  if (await store.get(id)) throw new WorkspaceConflictError(id);
  const now = new Date().toISOString();
  const record: Workspace = {
    id,
    name: opts.name ?? id,
    members: [],
    connectors: [],
    createdAt: now,
    updatedAt: now,
    about: opts.about ?? null,
  };
  const dir = join(store.getWorkspacesDir(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(dir, "workspace.json"), record);
  await scaffoldWorkspace(dir);
  let ws = record;
  for (const m of opts.members ?? []) ws = await store.addMember(id, m.userId, m.role);
  return ws;
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
    await seedWorkspace(wsStore, wsId, {
      name,
      members: memberIds.map((userId) => ({ userId, role: "admin" as const })),
    });
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
