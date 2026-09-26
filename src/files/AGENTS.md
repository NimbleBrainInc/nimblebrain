# Files

Scope: the workspace file store, paths, and the file locator (`src/files/`). Workspace-level rules are in `src/workspace/AGENTS.md`.

## Files are workspace-owned

A file lives at `workspaces/<wsId>/files/<ownerId>/<fileId>_<name>` (per-owner registry + bytes + sidecars in that partition), so the directory is the boundary: cross-workspace reads fail by construction and `workspace delete` archives files with the rest of the workspace. `FileEntry.ownerId`/`workspaceId` are denormalised — the path is authoritative.

- **Build a store ONLY via `runtime.getWorkspaceFileStore(wsId, ownerId)`**, which constructs through `workspaceFilesDir` from `src/files/paths.ts`, the single sanctioned site. `check:file-paths` rejects the identity-scoped `getIdentityContext(...).getDataPath("files")`.
- **A `files://<id>` URI stays bare.** The workspace is NOT in the URI; it comes from the ambient request. `files__*` is an identity-door tool, so the workspace comes from `RequestContext.workspaceId` — the single workspace a request is bound to, set on every door:

  | Door | Workspace |
  |---|---|
  | chat | the conversation's own `convWsId`, so a resumed chat's files follow the conversation, not the client's focus |
  | automation run | provenance |
  | `/mcp/<wsId>` | the membership-validated workspace in the URL |
  | REST | the validated header, else the caller's personal workspace |

  No workspace in scope ⇒ file storage denies (e.g. a background job with none bound).
- **The browser serve endpoint is bare too** — `GET /v1/files/:id`, no workspace, no query. A browser `<img>` GET can't send `X-Workspace-Id`, so the workspace is resolved from the globally-unique id via the process-wide `FileLocator` (`src/files/locator.ts`, `runtime.getFileLocator()`), which searches ONLY the caller's own owner partitions. The owner partition is both the gate and the search scope — no client-supplied coordinate, and a request reaches only the caller's own bytes.
- **The locator's `fileId → wsId` memo is never the source of truth.** `getWorkspaceFileStore` keeps it current (remember on write, forget on delete), and a stale hit self-heals via a disk re-walk.
- **Reading a file SHARED by another owner** (future `visibility: shared`) is a separate, visibility-checked path — never a widening of this locator to other owners.

Files an automation run writes land in the run owner's partition here, referenced from the run result.
