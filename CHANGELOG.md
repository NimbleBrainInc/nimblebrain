# Changelog

## [Unreleased]

### Highlights

- **Composio-backed Gmail and Outlook connectors** (stopgap until our own restricted-scope verification at Google / Microsoft lands). New `auth: composio` discriminator in the catalog routes through `@composio/core` as a remote OAuth aggregator: install → adopt-or-create Composio session → user does vendor OAuth → tool calls flow through Composio's MCP endpoint. The platform persists only an opaque `connectedAccountId` per workspace; no vendor tokens ever land in `workspace.json`. Catalog entries carry a curated `composio.tools` allowlist so the agent's tool-search sees a working set instead of every tool the toolkit publishes (Outlook alone has 282). Operator setup is one secret-store item per toolkit; adding a new Composio toolkit is one catalog entry + one env var (no code change). See the [Composio operator guide](https://docs.nimblebrain.ai/deploy/composio/) for end-to-end setup.
- **Platform sources unified on MCP.** Every tool/resource provider — built-in platform capabilities and user-installed bundles alike — is now an MCP server. Built-ins run in-process over `InMemoryTransport`; bundles continue to run as subprocess or remote MCP. One contract, one shape, one set of capabilities.
- **Task-aware iframe tools** — widgets can now `callToolAsTask` for long-running tools (research runs, batch imports). The `/mcp` endpoint speaks the MCP 2025-11-25 tasks utility, and the iframe bridge always routes `tools/call` and `resources/read` through `/mcp` (legacy REST branches in the bridge are gone). The `/v1/tools/call` and `/v1/resources/read` REST endpoints stay for the web shell.
- **Bundle-side custom instructions.** Bundles publish `app://instructions`; the platform reads it on every prompt assembly and wraps non-empty bodies in `<app-custom-instructions>` containment in the system prompt. Zero opt-in flag, zero new platform-side infrastructure per bundle ([docs](https://docs.nimblebrain.ai/apps/custom-instructions/), [#98](https://github.com/NimbleBrainInc/nimblebrain/pull/98)).
- **Settings IA refactor.** Nav grouped by scope (This Workspace / Organization). Profile un-nested to top-level `/profile`. New shell `UserMenu` (avatar + popover) is the canonical path for identity actions; sidebar collapse moved to a half-overflow edge button. Old URLs redirect.
- **Connector registries unified on upstream MCP `ServerDetail`** — both the bundled curated catalog and mpak now flow through one wire shape and one client-side projection. mpak is consumed via `@nimblebrain/mpak-sdk@0.8.0`'s `searchServers` (native `/v1/servers/search`), so brand icons land in the Browse list, in installed-stdio-bundle rows, and on the Configure page through one `iconUrl` field — no more parallel stdio-catalog YAML lookup ([#195](https://github.com/NimbleBrainInc/nimblebrain/pull/195)).
- **`ConnectorDirectory` facade** — single read-side seam for the registry layer. Sources (`StaticSource`, `MpakSource`) implement just `fetch(): Promise<ServerDetail[]>`; the directory owns scope filtering, projection, error aggregation, dedup, and the lookup tables (`catalogByUrl`, `iconByPackage`, `catalogById`). Adding a new source type is a ~20-line `fetch()` body with everything else inherited. Replaces `DirectoryAggregator` + the four standalone helper functions that previously bypassed the registry instances.
- **`scopes[]` filter on `RegistryConfig`** — restrict a registry instance to one or more namespaces. Match is OR-of-prefixes against either the reverse-DNS prefix of `ServerDetail.name` (e.g. `ai.nimblebrain` matches `ai.nimblebrain/echo`) or the npm scope of `packages[].identifier` (e.g. `nimblebraininc` matches `@nimblebraininc/echo`). Operators can run multiple mpak rows with different scopes side-by-side. The seeded mpak row defaults to `scopes: ["nimblebraininc"]` — narrow-by-default for first installs; broaden by editing the row.
- **15 new DCR remote-OAuth connectors in the curated catalog** — Linear, Canva, Cloudflare, Intercom, Mercury, Neon, PayPal, Sentry, Stripe, Vercel, Webflow, Wix (workspace-scoped, all DCR — point-and-click installs, no operator setup). Granola moves from user to workspace scope so teams share one connection. Notion was already in the catalog. Brand icons sourced from `static.nimblebrain.ai/icons/<name>.png`.
- **Connector serverName slugified from canonical reverse-DNS form.** A new `slugifyServerName(canonicalName)` rule transforms `ServerDetail.name` (e.g. `com.canva/mcp`) into a URL-safe, filesystem-safe, collision-free single-segment slug (`com-canva-mcp`) at install time. Both source types use the same rule so a connector's `serverName` is uniform regardless of whether it came from the curated catalog or mpak. The whole-namespace preservation eliminates the rightmost-segment collision class (`com.acme.crm/mcp` and `com.foobar.crm/mcp` produce distinct slugs, where last-segment derivation would have collapsed both to `crm`).
- **`bun run check:catalog` + PR-gated GitHub Action** for catalog rot detection. Runs the platform's exact OAuth-discovery chain (RFC 9728 protected-resource → RFC 8414 AS metadata → RFC 7591 `registration_endpoint`) against every `auth: dcr` entry in `catalog.yaml`. Fails the PR if a vendor URL goes 5xx, drops DCR support, or moves their well-known metadata path. Network-dependent; not part of `bun run verify`. Triggered by `pull_request` paths-filter on `src/connectors/catalog.yaml`.

### Added

- `auth: composio` third connector auth kind alongside `dcr` and `static`. Discriminator lives in `_meta["ai.nimblebrain/connector"].auth` on `ServerDetail` entries; the install path branches at `handleInstallRemoteOAuth`, eager-starts the source via Composio's session URL (no native MCP OAuth handshake — Composio's static `x-api-key` is the transport credential), and writes a parallel state file at `credentials/composio/<connectorId>/connection.json`. Disconnect deletes the Composio-side account (best-effort) plus the local `connection.json`. Catalog entries declare `composio.toolkit`, `composio.authConfigEnv` (env var name for the `ac_…` id), and an optional `composio.tools` allowlist.
- `src/composio/sdk.ts` — single SDK adapter module. Owns every `@composio/core` import: `composio.create` (with `sessionPreset: "direct_tools"` so the toolkit's real tools appear on MCP, not the meta-router), `connectedAccounts.{list,initiate,delete}`, eager `validateComposioConfig` (open-redirect mitigation on `COMPOSIO_API_BASE_URL`; multi-tenant `NB_TENANT_ID` enforcement when the bouncer is configured), 10-second timeout wrapper on every SDK call, and the canonical `composioUserId(wsId)` formula that the route and install layers both consume.
- `/v1/composio-auth/{initiate,callback,proxy}` routes. `initiate` adopts an existing ACTIVE Composio connected account when one exists (skips the redirect dance entirely) or kicks off a fresh flow with `allowMultiple: true`. `callback` verifies a sha256-bound nonce cookie + URL params + cid, writes `connection.json`, transitions lifecycle state to `running`. `proxy` is the white-label forwarder for the vendor-side redirect URI.
- Gmail (`com.google/gmail`) and Outlook (`com.microsoft/outlook`) connectors with curated 15-tool allowlists. Without the allowlist Outlook would surface 282 tools and the agent's `nb__search` would dump every match's full description (≈220K tokens) into context — gpt-class models would 400, Claude would burn 400K tokens per turn. The allowlist is per-catalog-entry; adding a new Composio toolkit is one catalog entry + one env var + one Composio dashboard config.
- Workspace files are now first-class MCP resources at `files://<id>`. The `files` in-process source advertises every registry entry via `resources/list` and serves bytes via `resources/read` (text MIMEs as `text`, others as `blob`), reachable from any MCP client.
- `bun run dev:worktree` — runs the platform from any git worktree against a worktree-local `.nimblebrain-worktree/` workdir on alt ports (27271 API / 27270 web), in dev mode with no auth. For smoke-testing a feature branch without disturbing your primary dev or another worktree's state; suitable for Chrome DevTools E2E. See `AGENTS.md` § Worktree dev.
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

- Uploaded images are persisted in conversation JSONL as MCP `resource_link` blocks pointing to `files://<id>` instead of inline `Uint8Array` bytes. The runtime rehydrates them to AI SDK V3 `file` parts at the `model.doStream` boundary, so vision content is now stable across multi-turn agent loops (previously dropped on turn 2+). Existing JSONL files are read forward without migration; legacy `image` blocks are quietly omitted on reconstruction (same as the pre-fix behavior).
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

### Breaking

- **Registries unified on upstream MCP `ServerDetail`** ([#195](https://github.com/NimbleBrainInc/nimblebrain/pull/195)). Operator-facing migrations:
  - `RegistryType` values `"curated"` / `"directory"` renamed to `"static"` / `"mcp"`. Any `NB_REGISTRIES` JSON pinning the old strings must be re-typed; `registries.json` is auto-migrated on next read by re-seeding the locked default.
  - The locked seeded registry id `"curated"` is now `"bundled-static"`. Existing `registries.json` rows are preserved; the new id is re-added if missing.
  - Seeded mpak registry rows no longer carry a hardcoded `url` — the mpak SDK owns its default registry host. Operators with a stale `url: "https://mpak.dev"` (the marketing site, not the registry) on a persisted mpak row should drop the field; self-hosted operators set `url` explicitly via the admin UI or `NB_REGISTRIES`.
  - `DirectoryEntry.id` (and `InstalledConnector.catalogId`) is now the reverse-DNS `ServerDetail.name` (e.g. `io.asana/mcp`) instead of bare slugs (`asana`). Catalog-keyed state — `workspace.json#oauthOperatorApps[<id>]` and the matching `<id>.client_secret` credential entries — must be rekeyed to the reverse-DNS form before existing static-auth connectors will resolve.
  - `NB_CATALOG_PATH` removed (was previously deprecated; never deployed). Use `NB_REGISTRIES` with a `static`-type registry pointing at a `ServerDetail[]` YAML/JSON file.
  - `BundleInstance.serverName` for new installs is now the slugified canonical reverse-DNS form (`com-canva-mcp`, `dev-mpak-nimblebraininc-echo`) instead of a short brand slug. Existing installs keep their persisted `serverName` and continue to resolve under the legacy form via `serverNameFromRef`'s fallback. Operators querying by `serverName` (logs, audit, `manage_connectors.uninstall`) need both forms during the transition; new installs of an existing bundle use the new slug.
- **Token-usage shape unified.** The runtime, engine, and conversation events now share a single `TokenUsage` struct (`{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`). Internal layers that exposed flat fields are restructured:
  - `EngineResult.inputTokens` / `outputTokens` → `EngineResult.usage`. `EngineResult` also gains `usage` and `llmMs` (the side-channel `RunMetricsCollector` is gone).
  - `TurnUsage` now extends `TokenUsage`. Top-level `inputTokens` / `outputTokens` / `cacheReadTokens` are still present (via the extension) but `costUsd` is **removed** — cost is computed at the API boundary from `(model, usage)`. Wire-format clients (`done` SSE event, `POST /v1/chat`) still see `usage.costUsd`.
  - `ChatResult` no longer has top-level `inputTokens` / `outputTokens`. Read them from `result.usage.inputTokens` / `result.usage.outputTokens`. The wire format (HTTP response) keeps the top-level fields for backward compatibility.
  - `ChatFnResult` (exported from the automations bundle) drops top-level `inputTokens` / `outputTokens`; `usage` now contains them. External `ChatFn` implementers must update.
- **`Conversation.totalInputTokens` / `totalOutputTokens` / `totalCostUsd` removed.** Totals are derived from events at read time and surfaced on `ConversationSummary`. Stores no longer maintain rolling totals on the line-1 metadata; pre-deploy values written there are ignored.
- **`StoredMessage.metadata.usage` replaces flat `inputTokens` / `outputTokens` / `cacheReadTokens` / `costUsd`.** Pre-deploy assistant messages with the flat shape produce no derived usage (deliberately — see "Old usage data shows zero" below).
- **JSONL `llm.response` event shape changed.** Per-call usage is now nested under `usage` instead of flat `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` / `reasoningTokens` siblings. Field rename: `cacheCreationTokens` → `cacheWriteTokens` to match AI SDK V3 vocabulary.
- **SSE `llm.done` event shape changed.** `POST /v1/chat/stream` consumers that subscribe to per-iteration token counts must read `data.usage.inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` instead of the previously-flat `data.inputTokens` / `data.outputTokens` / `data.cacheReadTokens` / `data.cacheCreationTokens` / `data.reasoningTokens`. The `done` event's wire shape (`usage.costUsd` etc.) is unchanged.
- **`UsageReport` `cost.cacheCreation` / `tokens.cacheCreation` renamed to `cacheWrite`.** External consumers of `aggregateUsage` output read `undefined` until updated.
- **`UsageReport.tokens.input` is now non-cached input only.** Pre-fix it was the AI SDK V3 grand total (which already includes cache reads and cache writes). Post-fix it's the non-cached portion, so `tokens.input + tokens.cacheRead + tokens.cacheWrite` equals the grand total — same shape as the cost breakdown and the Anthropic dashboard. External consumers will see lower `tokens.input` numbers; switch to summing the three buckets for grand-total input.
- **Old usage data shows zero after deploy.** Conversations created before this release have token totals on disk in the old (flat-field) shape. The new readers do not migrate that data — they skip it and contribute zero. Existing-conversation rows in the conversation list and the usage dashboard show $0 / 0 tokens for activity that predates the deploy. New turns from the deploy onward show correct numbers (now including cache writes, which were under-billed before).

### Fixed

- Agent runs no longer burn the iteration budget on a stuck MCP tool. Three additions cooperate: outbound args drop no-op optional values (empty strings, nil UUIDs, empty arrays) that some upstream APIs reject as malformed; tool results whose text looks like an upstream error (e.g. `Ran into an error: AxiosError…`) but ship `isError: false` are promoted to `isError: true` so downstream layers see truth; a per-run supervisor watches each tool for identical-fingerprint repeats and, on the 3rd, replaces the result with a stop-directive plus a one-shot system-prompt nudge so the model surfaces the error and ends the run instead of looping to `max_iterations`.
- Vision content is no longer dropped after the first turn of an agentic loop. Uploaded images survived turn 1 (the in-memory message still carried the bytes) but disappeared on turn 2+ — the user-message reconstructor filtered everything except text. Multi-turn flows like "extract from screenshot, then call a CRM tool" now work end-to-end.
- `estimateCost` no longer double-bills reasoning tokens for models with a separate `cost.reasoning` rate. Reasoning is a subset of `outputTokens` per the V3 usage spec; the corrected formula splits rather than adds.
- `estimateCost` no longer double-bills cache tokens. AI SDK V3's `inputTokens.total` is the grand total of all input-side tokens (including cache reads and cache writes); the prior formula charged the grand total at the full input rate AND charged the cache subsets again at their respective rates — a ~3x overcharge on cache-heavy turns. Fix subtracts cache subsets from the input total before applying the input rate. ([#140](https://github.com/NimbleBrainInc/nimblebrain/issues/140), [#151](https://github.com/NimbleBrainInc/nimblebrain/pull/151)).
- Live per-turn `usage.costUsd` (returned via the `done` SSE event and `POST /v1/chat`) now correctly includes cache write and reasoning costs. Previously the runtime layer dropped these fields before computing cost, under-billing cache writes and mis-billing reasoning. Cost is now computed at the API boundary from the canonical `TokenUsage` struct, so the live wire-format value matches what the catalog math produces.
- `EventSourcedConversationStore.fork()` now wraps each forked `llm.response` in synthetic `run.start` / `run.done` bookends. Previously, `history()` on a forked event-format conversation returned only user messages — the reconstructor only emits assistant turns inside an active run scope, and the unbookended events fell through to the "skip events outside a run context" branch. Independent of the cost work; surfaced during PR #151's QA.
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
- Registry URL editing on the Org → Registries settings page (and the `manage_registries set_url` action). URL overrides (e.g. self-hosted mpak) are deployment config — set via `NB_REGISTRIES` or `registries.json`. The UI now shows the configured URL or "(using default)" as read-only.

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
