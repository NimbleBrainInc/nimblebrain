# Changelog

## [Unreleased]

### Added

- `nb__read_resource` system tool — the agent can now load `skill://` / `ui://` resources advertised by an installed bundle's MCP server ([#3](https://github.com/NimbleBrainInc/nimblebrain/pull/25)).

### Changed

- Apps list in the system prompt now surfaces each bundle's `initialize.instructions` inside `<app-instructions>` containment tags, so per-bundle guidance reaches the LLM.

## [0.4.0] - 2026-04-24

### Highlights

- **MCP OAuth for external clients** — Claude Code, Claude Desktop, Cursor, and any RFC 9728/8414-compliant client can connect to `/mcp` via WorkOS AuthKit. Works behind TLS-terminating proxies ([docs](https://docs.nimblebrain.ai/guide/mcp-connect/)).
- **Workspace-scoped credentials** — per-bundle files (`0o600`), 3-tier resolver (workspace store → `mcp_config.env` alias → manifest default).
- **OAuth client for remote MCP sources** — NimbleBrain can now consume third-party MCP servers that require user identity.
- **Tool-call UX** — parallel calls collapse into a single accordion, engine errors render inline, `resource_link` blocks render PDFs and binaries, 20s SSE heartbeat keeps long streams alive.

### Breaking

- `files__write` → `files__create`. Hand-coded external callers must update.
- `GET /v1/apps/:name/resources/:path` now returns a JSON envelope matching `POST /v1/resources/read`. Binary payloads come back as base64 in `blob`.
- `nb config set|get|clear` require `--workspace`/`-w <wsId>`.
- Engine-level MCP task exports removed (`ActiveTaskTracker`, `pollTask`, `isCreateTaskResult`, `McpTask`, et al). Drive tasks via `ToolRouter.execute(call, signal)` + `tool.progress` events.

### Added

- `POST /v1/resources/read`.
- Docker images on GHCR (`ghcr.io/nimblebraininc/nimblebrain{,-web}`) alongside ECR.
- Claude Opus 4.7 in the model catalog.

### Fixed

- **Chat uploads are now visible to `files__*` tools.** Operator action: run `bun run scripts/migrate-tenant-files.ts [workDir]` to migrate pre-existing uploads.
- Context-doc uploads >1 MB no longer 413.
- MCP OAuth resource URL honors `X-Forwarded-Proto` behind ALB/nginx/Caddy ([docs](https://docs.nimblebrain.ai/deploy/security/#mcp-oauth-behind-a-reverse-proxy)).
- Concurrent chat runs on the same conversation return `409` instead of racing.
- Workspace bundles start concurrently at boot (faster startup on busy instances).
- `InlineSource.execute()` validates input against `inputSchema` — malformed `/mcp` calls no longer leak Node internals.
- Many smaller UI and streaming-reliability fixes.

### Removed

- `NB_CONFIG_*` env-naming convention — replaced by SDK-declared env aliases.
- Legacy standalone files MCP server (superseded by the inline source).

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
