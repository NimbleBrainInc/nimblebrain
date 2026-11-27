# Workspaces

Scope: the workspace store, its on-disk root, ids, authorization, provisioning, and deleted workspaces (`src/workspace/`). The rules for what lives *inside* a workspace sit beside that code: conversations in `src/conversation/AGENTS.md`, files in `src/files/AGENTS.md`, tasks in `packages/tasks/AGENTS.md`, credentials in `src/tools/AGENTS.md`, the tool wall in `src/orchestrator/AGENTS.md`. Gating a write in the web tier is in `web/AGENTS.md`.

## Workspace roots

**A workspace root is created by `WorkspaceStore.create` (and the `scaffoldWorkspace` it calls), and by nothing else.** The rule is `assertWorkspaceRootExists(dir)` (`src/workspace/context.ts`), which derives the `workspaces/<wsId>` prefix from the path it is handed and throws `WorkspaceRootMissingError`, naming the workspace, when that root is absent or holds a tombstone no purge has begun on (a deleted workspace is frozen, so a restore is exactly what was deleted; once `purgeAt` is set only the purge's teardown runs there, and its `rm` takes what it wrote). **Every workspace-scoped mkdir passes it** — via `ensureWorkspaceDir` (assert-then-mkdir, for a plain recursive mkdir at the default mode: the tasks store, both conversation stores, the file store, the notification inbox, `writeSkill`), or called directly ahead of a writer's own `mkdir` where the mode or the async form has to be kept (`permissions/permission-store.ts`, `connectors/providers/composio/connection.ts`, `tools/credential-store.ts` — the last three write at `0o700`).

The prefix is derived by scanning for the first `workspaces/<wsId>` **pair**. Testing the segment after the last `workspaces` is not the same thing and is not safe: a path *ending* in `workspaces` has no successor to test, so it read as "not a workspace tree" and fell through to the unguarded mkdir — reachable by naming a task "Workspaces", since `taskRunsDir` ends in `runs/<taskId>`.

A path outside any workspace tree (org skills, `users/<id>/skills/`, the instance credential dir, a test's temp dir) has no root to require and passes — which is why a writer shared across scopes, like `writeSkill` or `CredentialStore.put`, takes the guard for its workspace callers without changing what it does for the others.

This is structural rather than per-writer on purpose. A purge removes the subtree out from under every writer holding a path into it, those writers mkdir recursively, and without the guard the first one to fire afterwards re-creates the purged workspace's directory — invisibly, because `list()` skips a workspace dir whose `workspace.json` will not parse, so the resurrected tree appeared nowhere and was never deleted again. There is no way to grep for "everywhere that writes into a workspace", so guarding each writer is a discipline problem; the rule lives at the mkdir instead. **Do not add a recursive mkdir on a workspace-scoped path without it**, and do not "fix" a `WorkspaceRootMissingError` by creating the root — the workspace is gone, and the caller's job is to stop.

A store still creates its own subdirectory on first write. `WORKSPACE_DIRS` (`src/workspace/scaffold.ts`) scaffolds `data/`, `credentials/`, `skills/` and `files/`; what is NOT pre-created is `conversations/`, `notifications/`, `tasks/`, and the per-owner partition beneath `files/` and `tasks/`. That stays true; the guard is about the root, not the subtree.

## Deleted workspaces

**One rule for every capability, owned by the kernel: a delete makes a tombstone, the purge
reconcile removes it after the retention window, and an admin can restore it before then.**
No contract has an archive or restore; plugins only ever see `delete_workspace`, at the purge.

- **The tombstone is `workspaces/<wsId>/deleted.json`** (`WorkspaceTombstone`: `deletedAt`,
  `deletedBy`, and `purgeAt` once a purge began or was asked for). Its own file, so no
  read-modify-write of `workspace.json` can drop it. `get` and `list` leave a tombstoned
  workspace out, so every door answers it as not found and every write through the store
  is refused; `getDeleted` / `listDeleted` read it.
- **Delete changes nothing else** (`Runtime.deleteWorkspace`): the run worker drops it, its
  connectors are stopped and forgotten in the process, and no plugin is called. Writers that
  took a path before the delete are refused by the root guard. Members,
  record, files, secrets and every plugin's records stay, so a restore is complete.
- **Restore** (`Runtime.restoreWorkspace`) removes the tombstone, starts the connectors as
  boot does and serves the workspace in the run worker. Refused once `purgeAt` is set or the
  window has passed: a purge that began is only ever finished.
- **Delete, restore and purge run one at a time per workspace** (`oneAtATime`); a zero-window
  delete runs its purge inside its own turn.
- **The purge** (`Runtime.purgeWorkspace`):
  set `purgeAt`; call `delete_workspace` as `host` on every bound server whose contract makes
  it private, walled to the workspace with no owner (it crosses every owner, and is the host's
  call whoever deleted or purges); tear down the
  connectors; delete the workspace's secrets through `CredentialStore`; `WorkspaceStore.remove`
  (record first, then the directory). A plugin's error stops it there and leaves the
  tombstone. Every step is idempotent, so the next pass finishes whatever stopped.
- **The reconcile** (`Runtime.purgeDeletedWorkspaces`) runs at boot and hourly and purges
  every tombstone whose window (`workspaces.deletedRetentionDays`, default 30; 0 purges inside
  the delete) has passed. It also removes each `archived/<name>` directory an earlier release
  left, once its mtime is older than the window: its plugins were purged and its connectors
  torn down when it was archived, so there is nothing to call or restore.
- **Kept past the purge**: the usage ledger (the org's spend record, retained by its own
  window) and each person's per-workspace skill switches under `users/`.

## Write authorization

A workspace-scoped write **should** route through `canWriteWorkspaceScoped`, and a client gate that disagrees with it is a bug — but do not read that as an invariant you can lean on. **The helper is a convention, not a chokepoint.** Writes reach the store by other paths: some gate through wrappers that delegate to it (`isWorkspaceAdmin` in `src/tools/connector-tools.ts`), and `manage_workspaces update` patches `workspace.json`'s `connectors` behind an org-admin gate instead — not a hole, since an org admin can delete the workspace outright and no web caller sends `connectors`, but not the helper either.

So read the write path. Do not assume a call site is covered because the helper exists, and do not assume it is uncovered because the helper is absent.

**Membership and the name are governed at org scope, not written as content.** `canManageWorkspaceMembers` (`src/workspace/authz.ts`) gates `add_member`, `remove_member` and `update_member`, and `canRenameWorkspace` (the same rule) gates a name-only `manage_workspaces update`: an org admin may manage any workspace's roster and name, as they may create or delete the workspace, and a workspace admin member may manage their own. Reading the roster (`list_members`) is open to every member (`canReadWorkspaceMembers`), since members share the workspace with everyone on it; the connector list in `update` stays org-admin only. Who can reach a workspace is an org concern; what the workspace contains is not. Do not route member management back through `canWriteWorkspaceScoped`: that strands the org admin, who owns the workspace's existence, outside its access. This does widen reach: an org admin can seat themselves and then read and write the workspace like any admin member. That is intended, and it is visible: they appear in the roster while seated, and every roster change is logged with its actor, so leaving the roster afterward does not erase it. The last-active-admin guards apply to an org admin like anyone else.

## Workspace ids

**Workspace ids are opaque and name-independent.** A workspace's id is `ws_<16-hex>`, generated by `generateWorkspaceId()` (`src/workspace/workspace-store.ts`), assigned once at create time and never derived from the name. Renaming a workspace via `WorkspaceStore.update({ name })` does NOT change the id, the on-disk dir (`workspaces/<wsId>/`), or the URL (`/w/<wsId-without-ws_>`). The id is opaque *by contract*: never parse it for meaning, never reconstruct it from a name or a user id, and don't assert a specific value in tests — assert the shape (`WORKSPACE_ID_RE`) or use the id returned from `create`. The alphabet has no `-`, so an id never collides with the workspace/tool separator in `ws_<id>-<tool>`.

**There is one id grammar, and it is the generated form.** `WORKSPACE_ID_RE` (`^ws_[a-f0-9]{16}$`, case-sensitive, `src/workspace/workspace-id-pattern.ts`) decides what the store creates, loads, and addresses, and what every door accepts. `create` asserts each id it mints against it, so a generator change that drifts throws at the first create. `WorkspaceStore.create(name, opts?)` takes no id or slug, and `nb__manage_workspaces` declares `additionalProperties: false`, so a `slug` or `id` argument is refused by schema validation, not ignored.

**A directory whose name fails the grammar is no workspace.** `get` refuses such an id like any malformed one, and `list` skips the directory with a warning naming it. Renaming a workspace is an operator step, never a runtime rewrite: the id is in URLs, external MCP client configurations, and references the runtime cannot see. A test that needs a stable id seeds the record as an existing workspace (`seedWorkspace` in `test/helpers/test-workspace.ts`) with a generated-shape id rather than asking `create` for it.

## Provisioning the first workspace

**Every workspace is ordinary, however it was created (ADR-0039).** Nothing in the store or above it may treat a workspace differently for how it came to exist. A user who belongs to no workspace gets one from `ensureUserWorkspace` (`src/workspace/provisioning.ts`), called by bootstrap: an opaque id, `provisionedWorkspaceName(displayName)`, the user as admin. Nothing makes it the workspace the user opens: the URL names the workspace, and the server chooses none (ADR-0044).

- **Do not call `ensureUserWorkspace` on a per-request path.** It lists every workspace. Bootstrap is where the shell starts, so it is where a user with none gets one.
- **Do not provision on a request that names a workspace, or on an unattended run.** A request that names none is a caller error under every identity provider (`requireRequestWorkspace` in `runtime.ts`), and a task whose owner lost every membership is skipped, not given a new workspace.
- Concurrent calls for one user share one in-flight provisioning. The guard is per-process, which holds at `replicas: 1`.
