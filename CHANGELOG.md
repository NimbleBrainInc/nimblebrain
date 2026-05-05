# Changelog

## [Unreleased]

### Highlights

- **Platform sources unified on MCP.** Every tool/resource provider — built-in platform capabilities and user-installed bundles alike — is now an MCP server. Built-ins run in-process over `InMemoryTransport`; bundles continue to run as subprocess or remote MCP. One contract, one shape, one set of capabilities.
- **Task-aware iframe tools** — widgets can now `callToolAsTask` for long-running tools (research runs, batch imports). The `/mcp` endpoint speaks the MCP 2025-11-25 tasks utility, and the iframe bridge always routes `tools/call` and `resources/read` through `/mcp` (legacy REST branches in the bridge are gone). The `/v1/tools/call` and `/v1/resources/read` REST endpoints stay for the web shell.
- **Bundle-side custom instructions.** Bundles publish `app://instructions`; the platform reads it on every prompt assembly and wraps non-empty bodies in `<app-custom-instructions>` containment in the system prompt. Zero opt-in flag, zero new platform-side infrastructure per bundle ([docs](https://docs.nimblebrain.ai/apps/custom-instructions/), [#98](https://github.com/NimbleBrainInc/nimblebrain/pull/98)).
- **Settings IA refactor.** Nav grouped by scope (This Workspace / Organization). Profile un-nested to top-level `/profile`. New shell `UserMenu` (avatar + popover) is the canonical path for identity actions; sidebar collapse moved to a half-overflow edge button. Old URLs redirect.

### Added

- `compose__effective_context` debug tool — single-call answer to "what's in the system prompt for this conversation, with provenance per layer." Live mode returns the full traced composition; historical mode (`run_id` set) reads the recorded `skills.loaded` event for that run and verifies each layer-3 skill's `contentHash` against current source, with `_versions/` snapshot recovery on drift. Bundle filter narrows to one app's contributions ([#119](https://github.com/NimbleBrainInc/nimblebrain/issues/119)).
- `skills.loaded` events now carry a `contentHash` (SHA-256 hex) per skill — telemetry foundation for the `compose__effective_context` debug tool. ~64 bytes per skill per turn.
- Extended-thinking config (`thinking: off | adaptive | enabled` + `thinkingBudgetTokens`) in runtime config and Settings → Model; defaults to `adaptive` for catalog-flagged reasoning models, `off` otherwise ([#109](https://github.com/NimbleBrainInc/nimblebrain/pull/109)).
- Reasoning (extended-thinking) content is now captured end-to-end: `stream.ts` handles `reasoning-*` parts, the engine emits `reasoning.delta` SSE events, and the chat UI renders a collapsed "Thoughts" block above the assistant text. Empty turns with non-stop finishReason now emit a placeholder so replay surfaces truncations.
- `nb__read_resource` system tool — the agent can now load `skill://` / `ui://` resources advertised by an installed bundle's MCP server ([#3](https://github.com/NimbleBrainInc/nimblebrain/pull/25)).
- `defineInProcessApp` helper for building in-process MCP sources from JSON Schema tool defs and a resource map — same authoring ergonomic as the former `InlineSource`, with the full MCP capability surface (resources, instructions, tasks, future capabilities).
- `/mcp` advertises `tasks` and `resources` capabilities; tool-level `taskSupport` negotiation enforces JSON-RPC `-32601` for required-without-task and forbidden-with-task.
- `McpTaskStore` (in-memory, keyed by `${workspaceId}:${identityId}:${taskId}`) routes `tasks/{get,result,cancel}` to the originating engine handle with workspace-scoped authz; cross-tenant lookups return not-found.
- `McpSource` per-phase task methods (`startToolAsTask`, `awaitToolTaskResult`, `getTaskStatus`, `cancelTask`) with owner-context enforcement and TTL sweeper.
- `app://instructions` convention. Bundles publish; platform reads on every prompt assembly. Bundle owns storage, write tool, settings UI; platform owns URI, containment escape, fetch lifecycle. See [bundle-author docs](https://docs.nimblebrain.ai/apps/custom-instructions/).
- Org / workspace instructions overlays. `instructions://org` and `instructions://workspace` resources backed by `InstructionsStore` (8 KiB UTF-8 cap, atomic writes). Single tool `instructions__write_instructions(scope, text)` with role gates. Workspace overlay editor on `/settings/workspace/general`; org UI deferred (agent-writeable now).
- `useScopedRole` hook + `RouteGuard` component — centralized role determination for the web shell. Backend tools enforce roles independently — defense in depth.
- `UserMenu` in the shell sidebar (avatar + display name + popover with Profile settings + Sign out).
- Top-level `/profile` route. Identity isn't a setting; un-nested from `/settings/*`.
- Org-admin gate on `set_model_config` — backend now refuses non-org-admin writes (was UI-only via RouteGuard). Distinguishes "no identity" (cron, automations) from "wrong role" so debug logs make non-user code paths obvious.
- HTTP proxy primitive (`_meta["ai.nimblebrain/http-proxy"]`). Bundles can expose a loopback HTTP server (e.g. `astro preview`, Jupyter kernel) through the platform at `/v1/ws/<wsId>/apps/<bundle>/<mount>/*`. Loopback-only target, credentials and `Accept-Encoding` stripped on forward, `Set-Cookie`/CSP/X-Frame-Options stripped on response, per-workspace kill switch via `Workspace.allowHttpProxy`. Bundles get `NB_WORKSPACE_ID`, `NB_PROXY_PREFIX`, `NB_PUBLIC_ORIGIN` in their env at spawn ([docs](https://docs.nimblebrain.ai/apps/http-proxy/)).

### Changed

- Apps list in the system prompt now surfaces each bundle's `initialize.instructions` inside `<app-instructions>` containment tags, so per-bundle guidance reaches the LLM.
- Iframe bridge uses the MCP transport (`StreamableHTTPClientTransport` against `/mcp`) for `tools/call` and `resources/read`. `INTERNAL_APPS` authz still precedes transport selection. Bridge advertises `hostCapabilities.tasks` to iframes and forwards `notifications/tasks/status` on a per-bridge subscription.
- Inline (non-task) `tools/call` handler on `/mcp` now preserves `structuredContent` (was dropping it).
- Settings nav grouped by scope. "This Workspace" (General / Members / Usage / Apps) and "Organization" (Model / Workspaces / Users) replace the flat tab list. About is the footer. Per-bundle settings panels nest under "Workspace > Apps."
- Settings re-scoped by data ownership. Model → Organization (writes global `nimblebrain.json`, affects every workspace). Usage → This Workspace (uses `runtime.getWorkspaceScopedDir()`). MCP Connection card → Workspace > General.
- Sidebar collapse toggle moved to a half-overflow edge button on the sidebar's right border (Linear pattern).
- `manage_workspaces.list` now returns the requesting user's role within each workspace (`userRole?: "admin" | "member"`) so the web client can gate workspace-admin UI without an extra `list_members` round-trip.
- `POST /v1/chat` validation error wording. Hand-rolled checks (`"metadata must be a JSON object"`, `"allowedTools must be an array of strings"`) replaced with TypeBox path-prefixed errors (`"/metadata: Expected object"`, `"/allowedTools: Expected array"`). HTTP status (400) and `error: "bad_request"` are unchanged. External callers asserting on the exact wording need to update; the field name still appears in the message.
- Skill manifest writes now always include `metadata.keywords` and `metadata.triggers` as arrays (defaulting to `[]` when omitted by the caller). Previously a partial `metadata: { category: "X" }` could write a manifest with no `keywords`/`triggers` keys at all; the loader's domain type required them, so the divergence was a latent type lie. The on-disk JSON shape is now what the type always claimed.
- API responses now carry HSTS (`max-age=31536000; includeSubDomains`) and CSP (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'`) by default so direct-exposure self-hosted deployments aren't naked. Operators terminating TLS at a reverse proxy that already emits these can disable via `NB_HSTS=""` / `NB_CSP=""`, or override to a custom value via env var or middleware option ([#20](https://github.com/NimbleBrainInc/nimblebrain/pull/20)).

### Fixed

- `estimateCost` no longer double-bills reasoning tokens for models with a separate `cost.reasoning` rate. Reasoning is a subset of `outputTokens` per the V3 usage spec; the corrected formula splits rather than adds.
- `stopReason` now reflects the model's real finish reason (length, content_filter, error, other) instead of always reporting `complete`; per-call `finishReason` is persisted on `llm.response` events and forwarded over SSE ([#105](https://github.com/NimbleBrainInc/nimblebrain/pull/105)).
- Settings pages now share a unified layout system (`SettingsFormPage` / `ListPage` / `DashboardPage` / `AppPanelPage`) that owns header, width, save bar, and section spacing — replacing per-tab variations of all four. Bundle settings panels render inside settings chrome (back-link, title, "provided by" footer) instead of a chromeless iframe. Org-admin "manage workspace" back button now goes to the right route.
- `maxOutputTokens` is now derived per-call from the synced model catalog (`limits.output`) instead of a static 16,384 default — Opus 4.7 jumps from 16k → 128k, Sonnet 4.6 → 64k. Operator-pinned values still win, clamped to the model's catalog max ([#104](https://github.com/NimbleBrainInc/nimblebrain/pull/104)).
- Default thinking config now works on Claude Opus 4.7. The engine translates `thinking.type=enabled` (which Anthropic rejects for that model) into `adaptive` + `output_config.effort`, gated on a per-model `supportsEnabledThinking()` predicate ([#118](https://github.com/NimbleBrainInc/nimblebrain/pull/118)).
- Skills tool surface honest about its input contract: `skills__list` text emits a row per skill with id+metadata (was counts only); `scopeOfPath` no longer falsely classifies bare ids as `bundle`; path-validation error names the actual roots (`org/workspace/user/bundle`); mutation tools' descriptions point callers at `skills__list` for ids; `bundleNotMutable()` returns the structured `suggested_action` shape from the design doc.
- `skills__active_for` now defaults `conversation_id` to the current conversation when called from inside a chat (the agent doesn't know its own conv id; requiring it forced agents to skip the tool). Explicit ids still win; calls outside a chat scope error with a clear message instead of silently falling back.
- Files-app uploads no longer fail with `Payload too large`. Picker bytes now flow through `POST /v1/resources` (multipart, workspace-scoped) instead of being base64-encoded into a `tools/call` argument; `isAllowedMime` strips Content-Type parameters, fixing a latent miss in the chat ingest path too ([#93](https://github.com/NimbleBrainInc/nimblebrain/pull/93)).
- `nb__read_resource` and `POST /v1/resources/read` resolve `ui://` resources published by platform built-ins (settings, home, automations, conversations, files, usage, nb). Previously the structural type guard couldn't distinguish two divergent `readResource` shapes and silently skipped any platform source ([#90](https://github.com/NimbleBrainInc/nimblebrain/issues/90)).
- `/v1/resources/read` request-context propagation. The route handler wasn't wrapping its source-call in `runWithRequestContext`, so callback-form resource bodies that called `runtime.requireWorkspaceId()` (e.g. `instructions://workspace`) threw and surfaced as 404 "not found." Wrapping matches the existing `handleCallTool` pattern.
- `GET /mcp` returns 405 instead of opening an idle SSE listener. The standalone server→client stream was held open with nothing to write, so Bun's `idleTimeout` (and any L7 proxy: Vite dev, ALB, nginx) silently killed it — surfacing as `[vite] http proxy error: /mcp` + `socket hang up` and exhausting the SDK client's reconnect budget. The MCP SDK treats 405 as "no GET-style listening" and runs POST-only ([#138](https://github.com/NimbleBrainInc/nimblebrain/pull/138)).
- Settings model-picker no longer 404s non-Anthropic models. The dropdown now encodes `provider:` into option values (was `m.id` alone, dropping the provider grouped one level up at `optgroup`); the runtime resolves bare ids in the catalog so existing tenant configs continue to route correctly without re-saving. `getModelSlots()` returns fully-qualified ids so cost aggregation, capability checks, max-output and thinking resolvers, and log lines all see consistent shape — a tenant whose disk had bare `gemini-3.1-pro-preview` was previously routing to the Anthropic API ([#143](https://github.com/NimbleBrainInc/nimblebrain/pull/143)).
- PDF resource_link previews render again in Chromium / Arc. Chat iframe no longer sets `sandbox="allow-scripts"`, which made the frame an opaque origin and caused Chromium to refuse navigation to parent-owned `blob:` URLs (Arc surfaced this as "This page has been blocked by Arc"). PDFium's separate sandboxed renderer process is the actual security boundary for `application/pdf`; iframe `sandbox` is for untrusted HTML ([#144](https://github.com/NimbleBrainInc/nimblebrain/pull/144)).

### Removed

- `InlineSource`, `ResourceReader`, `isResourceReader`. External callers should switch to `defineInProcessApp` (returns an `McpSource`); `InlineToolDef` becomes `InProcessTool` with the same shape.
- `bridgeUseMcp` feature flag and its scaffolding (`web/src/features.ts`, `getBridgeUseMcp` / `setBridgeUseMcp`, the schema entry, the resolver field). The MCP transport is the only path; legacy REST branches in the bridge are deleted.
- Skill create/edit form no longer surfaces "Loading strategy" and "Tool affinity (comma-separated globs)" inputs. These fields exist on the on-disk `SkillManifest` but were never in the LLM-facing tool schema and were silently dropped by `skills__create` / `skills__update`. Operators who need them today should edit the skill markdown file directly under `~/.nimblebrain/{skills,workspaces/<wsId>/skills,users/<userId>/skills}/`; a future operator-only API may surface them.

### Operator notes

- All pre-IA settings URLs redirect to their new locations (`/settings/profile` → `/profile`, `/settings/users` → `/settings/org/users`, etc.). No action required for end users.
- Bundle authors who want to support custom instructions: publish `app://instructions` from your MCP server. See [the bundle-author guide](https://docs.nimblebrain.ai/apps/custom-instructions/) and the `synapse-todo-board` reference implementation.

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
