# Changelog

## [Unreleased]

### Breaking

- **Rename `files__write` → `files__create`.** The tool always generates a new id per call and never updates, so `create` matches both its semantics and how the model naturally calls it. External clients hand-coded against `files__write` must switch. In-process UI clients updated.
- **`nb__search.query` is now optional.** The schema previously declared `required: ["query"]` but the handler already defaulted to an empty string. Additive/relaxing — existing callers unaffected; new callers may omit `query` to list everything in scope.
- **Removed engine-level MCP tasks layer from public exports.** The following names are no longer exported from `src/index.ts`: `ActiveTaskTracker`, `pollTask`, `getImmediateResponse`, `isCreateTaskResult`, `isTerminalStatus`, and types `McpTask`, `McpCreateTaskResult`, `PollTaskOptions`, `TaskClientPort`, `TaskClientResolver`. The task lifecycle is now owned end-to-end by `McpSource.callToolAsTask` via the MCP SDK's experimental task streaming API — external consumers that imported these names should migrate to invoking tasks via `ToolRouter.execute(call, signal)` and observing the `tool.progress` event stream.

### Fixed

- **`features`, `maxHistoryMessages`, `maxToolResultSize`, and `files` are now loaded from `nimblebrain.json`.** These fields were accepted by the JSON schema and declared on `RuntimeConfig`, but `cli/config.ts` silently dropped them — so setting `features.mcpServer: false` or `maxHistoryMessages: 100` in a config file had no effect unless passed programmatically to `Runtime.start()`.
- Config schema now lists `userManagement` and `workspaceManagement` under `features` (previously only in code; setting them produced a spurious "unknown key" warning).
- `InlineSource.execute()` now validates input against the tool's declared `inputSchema` before dispatching. Closes the bug class where malformed tool calls via `/mcp` leaked Node-internal errors (`fs.readFile(undefined)`, `Buffer.from(undefined)`) as tool results.

### Removed

- Legacy standalone files MCP server at `src/bundles/files/` — dead code superseded by the inline source months ago.

## [0.3.0] - 2026-04-16

### Security

- **Scope bundle instances and placements by workspace.** When two workspaces had the same bundle installed, `Runtime.getBundleInstancesForWorkspace` returned instances from both (filtering only by `serverName`), causing briefing facets and the apps list to read entity data from other workspaces. `PlacementRegistry.unregister` was also global-per-serverName, so re-seeding in a second workspace silently wiped the first workspace's nav entries. Both paths are now workspace-scoped.

### Breaking (internal API)

Downstream forks or consumers that extend `BundleLifecycleManager` will need to update callsites:

- `installNamed(name, registry, env?)` → `installNamed(name, registry, wsId, env?)`
- `installLocal(bundlePath, registry, env?)` → `installLocal(bundlePath, registry, wsId, env?)`
- `installRemote(url, serverName, registry, transportConfig?, ui?, trustScore?)` → `installRemote(url, serverName, registry, wsId, transportConfig?, ui?, trustScore?)`
- `uninstall(nameOrPath, registry)` → `uninstall(nameOrPath, registry, wsId)`
- `startBundle(serverName, registry)` → `startBundle(serverName, wsId, registry)`
- `stopBundle(serverName, registry)` → `stopBundle(serverName, wsId, registry)`
- `recordCrash(serverName)` / `recordRecovery(serverName)` / `recordDead(serverName)` each gain a required `wsId` second argument.
- `BundleInstance.wsId` is now required (was optional). Every instance belongs to exactly one workspace; global/platform sources are represented as `InlineSource`, not `BundleInstance`.
- `PlacementRegistry.unregister(serverName, wsId?)` now scopes to `(serverName, wsId)` only. Passing no `wsId` removes only global entries; passing a specific `wsId` leaves other workspaces untouched.

### Migration

`installNamed` previously wrote bundle subprocess data to `{workDir}/data/{bundle}`. It now writes to `{workDir}/workspaces/{wsId}/data/{bundle}`, matching `seedInstance`. Self-hosted deployments that installed bundles via the runtime install path (rather than the startup seed path) should move existing data directories to the workspace-scoped layout or accept that old data is orphaned.

### Tooling

- `bun run verify` is now true CI parity. Added `format:check` (previously missed by CI) and split into `verify:static` + `verify:test-unit`; `ci.yml` invokes those subscripts so `package.json` is the single source of truth for "what CI runs."

### Other

- Auto-build bundle UIs during Docker image build and local `dev`.
- Update GitHub Actions workflows to latest major versions.

## [0.2.0] - 2026-04-15

- Add `dev:docs-demo` script for running the docs-demo environment with a preset dev identity.

## [0.1.0] - 2026-04-07

Initial public release.
