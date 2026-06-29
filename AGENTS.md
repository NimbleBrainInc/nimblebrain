# NimbleBrain

> This file is read by agents. Keep edits terse, imperative, token-aware. No long-form prose; bullets with concrete triggers and examples.

Self-hosted platform for MCP Apps and agent automations, built on Bun. Agentic loop + MCP bundle management + interactive UI host + cron-scheduled automations + skill-driven prompt composition + HTTP API + web client.

> This file is the operating manual — *how to work here* (build, conventions, gotchas). The domain model — *what the nouns mean and the invariants* — lives in [`CONTEXT.md`](./CONTEXT.md); architectural decisions — *why it's this way* — live in [`adr/`](./adr). Domain facts belong in `CONTEXT.md`; reference them from here rather than restating them.

## Build & Verify

```bash
bun install                # Install dependencies
bun run dev                # API (:27247) + Web (:27246) with watch/HMR
bun run dev:worktree       # Run from any worktree against an isolated workdir on alt ports — see "Worktree dev" below
bun run dev:api            # API only with auto-restart
bun run verify             # Full CI parity — runs every subscript below
bun run verify:static      # format:check + lint + check + check:cycles
bun run verify:test-unit   # test:unit + test:web

bun run test               # Unit + integration tests (all)
bun run test:unit          # Unit tests only (fast, ~10s)
bun run test:integration   # Integration tests only
bun run lint               # Biome linter
bun run format:check       # Biome format diff (no writes) — matches CI
bun run check              # TypeScript strict mode
bun run format             # Biome auto-format (writes)

cd web && bun install      # Web client dependencies (separate package.json)
cd web && bun run build    # Web production build → web/dist/

bun run build:bundles      # Rebuild every src/bundles/*/ui (vite single-file)
```

**`bun run dev` does NOT rebuild bundles.** The API serves each bundle from its pre-built `src/bundles/<name>/ui/dist/index.html`. After editing any file under `src/bundles/*/ui/src/`, run `bun run build:bundles` and restart the dev server (the API reads dist on iframe mount; it doesn't watch the file). Forgetting this means the iframe loads stale code while your changes look "live" in the source tree — a high-confusion failure mode.

**Before opening a PR, run `bun run verify`.** It is the single command that mirrors CI, enforced by construction: `.github/workflows/ci.yml` invokes only `verify:*` subscripts (plus `test:integration`) — no inline check steps. To add or change a check, edit the matching subscript in `package.json`; CI picks it up automatically. If CI ever catches something `verify` didn't, the fix is to update the subscript, not the checklist. Tool-level parity is the gate; discipline-level rules are not.

### Worktree dev

`bun run dev:worktree` runs the platform from any git worktree against a worktree-local workdir, on alt ports, with no auth gate — for QA on a feature branch without disturbing your primary `~/.nimblebrain` dev or another worktree's state.

| Setting | Value |
|---|---|
| Workdir | `<worktree>/.nimblebrain-worktree/` (auto-seeded; gitignored) |
| Config | `<worktree>/.nimblebrain-worktree/nimblebrain.json` (auto-seeded on first run) |
| API / Web ports | 27271 / 27270 (override via `NB_API_PORT` / `NB_WEB_PORT`) |
| Auth | none (dev mode — no `instance.json`) |
| LLM keys | `ANTHROPIC_API_KEY` (and friends) read from your shell environment |

Each worktree gets its own isolated state, so two worktrees can run side-by-side without colliding. Reset with `rm -rf .nimblebrain-worktree && bun run dev:worktree`. Share state across worktrees with `NB_WORK_DIR=/abs/path bun run dev:worktree`. Suitable for Chrome DevTools-driven E2E tests against `/v1/*` (no login dance).

## Conventions

- **Runtime:** Bun (not Node). Use `bun run`, `bun test`, `bunx`.
- **Module system:** ESM only. All imports use `.ts` extensions.
- **Linting:** Biome (not ESLint/Prettier). Run `bun run lint`.
- **Type checking:** `bunx tsc --noEmit`. Strict mode enabled.
- **Prefer typed-safe paths over `as unknown as T`.** When TS errors, find the input/output type matching runtime shape (e.g. stream-side vs prompt-side) before widening. Cast escape hatches require a comment naming the mismatch. Example: `src/model/inbound-fit.ts`.
- **Code-style rules beyond Biome/tsc live in [CODE_STYLE.md](./CODE_STYLE.md)** and are enforced by `bun run check:code-style` (part of `verify:static`). Add a rule when you find yourself enforcing the same pattern in review twice. Each rule lands with its check and the cleanup of existing violations in the same PR — otherwise it has no teeth.
- **HTTP framework:** Hono for routing and middleware. Typed context via `AppEnv`/`AuthEnv`.
- **Model types:** Use Vercel AI SDK V3 types (`LanguageModelV3`, `LanguageModelV3Message`, etc.) from `@ai-sdk/provider`. The engine calls `model.doStream()` directly.
- **No classes for data** — plain interfaces + factory functions preferred.
- **Tool results:** Return typed data in `structuredContent`, use `content` only for human-readable summary.
- **Errors:** Tool errors are caught per-call and returned as `isError: true` results. Engine errors surface via `run.error` event.
- **Documentation:** User- and operator-facing docs live in [`docs/`](./docs) (Astro + Starlight) and deploy to [docs.nimblebrain.ai](https://docs.nimblebrain.ai) via GitHub Pages. **Update them in the same PR as any user-facing change** (CLI, config, API, behavior) — co-locating docs with code is how we keep them from drifting. `docs/` is a standalone package: `cd docs && bun install`, then `bun run dev` / `bun run build` (or `bun run docs:dev` / `docs:build` from the root). The docs build runs an internal-link check and is a required CI gate on any docs change (`.github/workflows/docs-ci.yml`). `docs/` is excluded from `bun run verify` (biome/tsc are scoped to `src/` and `web/`). `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `AGENTS.md`/`CLAUDE.md` remain the standard top-level OSS files.
- **Per-directory agent docs:** any `AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it (`ln -s AGENTS.md CLAUDE.md`). Edit `AGENTS.md`. New per-directory docs follow the same pattern. Don't invert it (real `CLAUDE.md` + symlinked `AGENTS.md`) — it confuses tools that prefer one or the other.
- **CHANGELOG entries must be terse and scannable.** Target ~250–350 words per release (not per entry). Structure: short `### Highlights` with 3–5 one-sentence bullets, then `### Breaking` / `### Added` / `### Changed` / `### Fixed` / `### Removed`. One line per bullet; link to docs or the PR for depth instead of explaining implementation inline. Include migration-required operator actions (e.g. "run `scripts/migrate-tenant-files.ts`") in Fixed/Breaking. Cut internal refactors, release-pipeline polish, CI tweaks, and per-PR credit noise — they belong in `git log`, not the CHANGELOG. If a bullet needs more than one sentence to explain *what* changed and *why a reader cares*, either (a) link out or (b) rethink whether the reader needs this entry at all.

## Testing

Tests use `createEchoModel()` from `test/helpers/echo-model.ts` and `StaticToolRouter` to avoid LLM calls. No mocking of LLM providers needed.

Tests are organized into three tiers:

| Tier | Directory | Command | What belongs here |
|------|-----------|---------|-------------------|
| Unit | `test/unit/` | `bun run test:unit` | Pure logic, mocked deps, no I/O or servers |
| Integration | `test/integration/` | `bun run test:integration` | `Runtime.start()`, HTTP servers, real crypto, subprocesses |
| Eval | `test/eval/` | `bun run eval` | LLM evals, require `ANTHROPIC_API_KEY` |

Shared test helpers live in `test/helpers/` (imported by both unit and integration).

**Classification rule:** If a test calls `Runtime.start()`, `startServer()`, `Bun.serve()`, or `spawnSync()`, it belongs in `test/integration/`. Everything else goes in `test/unit/`.

## Project Structure

```
src/
├── engine/        Agentic loop (model → tool → repeat). Start here.
├── runtime/       High-level orchestration (Runtime.start → runtime.chat)
├── api/           HTTP API (Hono). Routes in api/routes/.
├── bundles/       MCPB bundle lifecycle (install/uninstall/start/stop)
├── tools/         System tool definitions (search, manage, delegate)
├── identity/      Auth adapters (dev, oidc, workos)
├── workspace/     Multi-tenant workspace isolation
├── skills/        Skill discovery and matching (triggers → keywords)
├── conversation/  Message persistence (JSONL, in-memory, event-sourced)
├── prompt/        System prompt composition (identity → core → apps → skill)
├── model/         LLM provider registry (AI SDK)
├── adapters/      EventSink implementations (logs, console, debug, telemetry)
├── cli/           Process entry: the serve HTTP API server (dev tooling is in scripts/)
└── files/         File context extraction
web/               Vite + React + TypeScript SPA (separate package.json)
```

## Key Entry Points

| File | Start here when... |
|------|-------------------|
| `src/engine/engine.ts` | Understanding the agentic loop |
| `src/engine/types.ts` | Core interfaces: ModelPort, ToolRouter, EventSink |
| `src/runtime/runtime.ts` | Orchestration: `Runtime.start()` → `runtime.chat()` |
| `src/runtime/types.ts` | RuntimeConfig, ChatRequest, ChatResult |
| `src/bundles/lifecycle.ts` | Bundle install/uninstall state machine |
| `src/api/app.ts` | HTTP routes and middleware |
| `src/tools/system-tools.ts` | System tools factory |
| `src/prompt/compose.ts` | System prompt assembly |

## Defaults

| Setting | Value |
|---------|-------|
| `models.default` | `anthropic:claude-sonnet-4-6` |
| `models.fast` | `anthropic:claude-haiku-4-5-20251001` |
| `models.reasoning` | `anthropic:claude-opus-4-6` |
| Max iterations | 25 (hard cap: 50) |
| Max input tokens | 500,000 |
| Max output tokens | 16,384 |
| Default bundles | none (platform capabilities are built in) |
| Work directory | `~/.nimblebrain` |
| API port | 27247 |
| Web port | 27246 |

## Workspace Isolation

All tool handlers that access data must be workspace-scoped. Use `runtime.requireWorkspaceId()` (never `getCurrentWorkspaceId()`). In dev mode it returns `"_dev"` — no special-case logic needed.

**Workspace ids are opaque and name-independent.** A non-personal workspace's id is an opaque token (`ws_<16-hex>`, generated by `generateWorkspaceId()` in `src/workspace/workspace-store.ts`), assigned once at create time and never derived from the name. The name is a freely-editable field — renaming a workspace via `WorkspaceStore.update({ name })` does NOT change the id, the on-disk dir (`workspaces/<wsId>/`), or the URL (`/w/<wsId-without-ws_>`). The id is opaque *by contract*: never parse it for meaning, never reconstruct it from a name, and don't assert a specific value in tests — assert the shape (`/^ws_[0-9a-f]{16}$/`) or use the id returned from `create`. The opaque alphabet is a strict subset of `[a-z0-9_]` so it never collides with the `-` workspace/tool separator in `ws_<id>-<tool>`. **Personal workspaces are the one exception**: they stay deterministic at `ws_user_<userId>` (via `personalWorkspaceIdFor`) for O(1) lookup by bootstrap, credential paths, and the personal-workspace invariants. `WorkspaceStore.create(name)` produces an opaque id; `create(name, slug)` honors an explicit slug (`ws_<slug>`) — used only by personal-workspace provisioning and deliberate operator/test overrides.

When adding a new code path that touches workspace-scoped credentials or identity, match the existing precedent: **hard-error on missing `wsId`, don't silently default**. `startBundleSource`'s named-bundle branch throws; the URL-bundle branch does too (for OAuth-provider paths). A `?? "ws_default"` fallback would pool credentials across tenants.

**Credentials live in the workspace, not the user.** Post-Stage-2 every credential file is reachable at `{workDir}/workspaces/<wsId>/credentials/...` and is constructed only through `WorkspaceContext` (via `runtime.getWorkspaceContext(wsId)`) or the primitives in `src/config/workspace-credentials.ts`. The pre-Stage-2 layout `{workDir}/users/<userId>/credentials/...` is fully deleted from the read path — the loader at `src/bundles/lifecycle.ts::assertBundleRefIsPostStage2` throws `LegacyOAuthScopeError` on any disk record carrying `oauthScope: "user"`, and operators must run `bun run migrate:user-creds` before deploying (see the Stage 2 deploy runbook). User-personal credentials live in the user's personal workspace at `{workDir}/workspaces/ws_user_<userId>/credentials/...` — the same code path serves them. `users/<userId>/...` is reserved for non-credential per-user data (currently `users/<userId>/skills/`); future per-user data follows the same convention. Hand-building `join(workDir, "users", userId, "credentials", ...)` paths is a regression caught by `check:credential-paths`.

**Conversations are workspace-owned.** Every conversation lives at `workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl` and is authorized by ownership (`Conversation.ownerId === access.userId`). The **path is the binding**: `Conversation.workspaceId` is set at create (the workspace the chat is born in, at the first message) and never mutated — there is no mid-chat workspace switching — so the directory is authoritative and the field is a denormalised convenience. **This binding is the session's workspace for the whole turn.** On resume, `_chatInner` resolves its tools, skills, apps, file partition, and the `## Workspace` prompt block against the conversation's own workspace (`convWsId`, read from the path by `resolveChatStore`) — never the client's currently-focused `X-Workspace-Id`. So a conversation answered while you're focused elsewhere stays sealed to its workspace (no cross-workspace tool/context leak); the focused workspace only decides where a **new** chat is born. **READ stays owner-gated; RESUME also requires current membership.** Reading an owned conversation (`findConversation`, the SSE event stream) consults ownership only — a removed member can still read their own authored conversation. But **resuming** binds the session's tools/skills/apps to `convWsId`, so it would hand the workspace's tools to someone offboarded from it; both `chat()` and `startTurn()` re-check membership of the conversation's workspace on resume and throw `ConversationWorkspaceAccessDeniedError` (→ `403`) for a non-member. This is a per-**resume** check (once per conversation load, at session establishment — exactly where the wall says the workspace must be membership-validated), NOT the per-call scan the wall forbids; personal workspaces are sole-member by construction, so they never gate. (This replaces the older "conversations outlive their workspace context" stance — a vestige of when conversations lived at flat top-level storage outside any workspace; they now live inside the workspace and are archived with it on delete, so active use is bound to membership. Files and automations carry the same offboarding shape and should follow — tracked in #586.) Construct dirs ONLY via `workspaceConversationsDir` from `src/conversation/paths.ts` (the single sanctioned site; the flat top-level `join(workDir, "conversations")` is now the regression `check:conversation-paths` catches). Read one conversation via `runtime.findConversation(convId, { userId })` and list via `runtime.listConversations(options, access)` — both route through the process-wide `ConversationLocator`, which resolves `convId → { wsId, ownerId }` across workspaces. The **user-facing list is always workspace-scoped** (`options.workspaceId`); there is no cross-workspace ("all workspaces") view. The no-filter `listConversations({}, access)` owner-across-workspaces enumeration is an **internal primitive only** (skills, usage aggregation) — never a user surface. Write via `runtime.workspaceConversationStore(wsId, ownerId)`. Deleting a workspace **archives** its subtree to `archived/<wsId>/` (archive-then-cascade), never a hard `rm`. **Personal workspace ids** go through `personalWorkspaceIdFor(userId)` from `src/workspace/workspace-store.ts` — no hand-built `"ws_user_" + userId` or `` `ws_user_${userId}` `` outside that helper (`check:personal-workspace-id` enforces).

**Files are workspace-owned.** Domain model and rationale: `CONTEXT.md` (→ File) and `adr/0002` (bare-id resolution), `adr/0003` (workspace-owned, path-authoritative storage), `adr/0004` (private-by-default). Rules when you touch files: build a store ONLY via `runtime.getWorkspaceFileStore(wsId, ownerId)` (constructs through `workspaceFilesDir` from `src/files/paths.ts`, the single sanctioned site; `check:file-paths` rejects the identity-scoped `getIdentityContext(...).getDataPath("files")`). A `files://<id>` URI stays **bare** — the workspace comes from the ambient request: `files__*` is an identity-door tool, so the resolved workspace rides `RequestContext.fileWorkspaceId` (chat = the conversation's own `convWsId`, so a resumed chat's files follow the conversation, not the client's focus; REST/`/mcp` = the validated `X-Workspace-Id`), and no workspace in scope ⇒ storage denies. The browser serve endpoint is bare `GET /v1/files/:id`, resolved from the id via `runtime.getFileLocator()` (no `?ws=`, no header), searching ONLY the caller's own owner partitions (the owner partition is both the gate and the search scope). `FileEntry.ownerId`/`workspaceId` are denormalised — the path is authoritative. Files an automation run writes land in the run owner's partition here, referenced from the run result. Operators run `bun run migrate:files-to-workspace` before deploying.

**Automations are workspace-owned.** An automation lives at `workspaces/<wsId>/automations/<ownerId>/<automationId>.json` (one file per automation) — construct paths ONLY via `src/bundles/automations/src/paths.ts` (`workspaceAutomationsDir` and friends; `check:automation-paths` rejects the identity-scoped `getIdentityContext(...).getDataPath("automations")` and hand-built `users/<id>/automations/` paths). Like files, `automations__*` is an identity-door tool, so the focused workspace rides `RequestContext.fileWorkspaceId`, NOT `scope.workspaceId` (the personal/session workspace). The scheduler scans `workspaces/*/automations/*/`, keys by `${wsId}/${ownerId}/${id}`, and a scheduled run **fires as its owner** — an identity-bound session **walled to** the automation's provenance `workspaceId` (its tools + the owner's identity tools), with NO cross-workspace reach. Membership in the provenance workspace is stamped from the creator's trusted context at create AND re-checked **per run**: `executeTask` denies a run whose owner is no longer a member of the provenance workspace (`WorkspaceMembershipRevokedError`, thrown before any tool binding) — the automations analog of the conversation-resume gate. The scheduler classifies that denial as a **skipped** run (not a failure — no `consecutiveErrors` bump, no auto-disable), so a removed owner's automation stops acting in the workspace immediately and **self-heals** if they're re-added. Personal workspaces are sole-member, so they never gate. **A run produces a run result, not a conversation.** Each run leaves a deliverable (final output), an activity log, and refs to any files it wrote (in the workspace file store) under `…/automations/<ownerId>/runs/<automationId>/` — an append-only `index.jsonl` of `AutomationRun` summaries plus a per-run `<runId>.result.json`. `runtime.executeTask` returns a `runId` and the deliverable and creates no conversation.

### Workspace tool namespacing — the wall

A chat or task session reaches **exactly one workspace** plus the caller's identity tools — never a cross-workspace union. That one workspace is the conversation's own (a chat, sealed at create and resolved from its path on resume) or the run's provenance workspace (a task) — **not** whatever the client is currently focused on. Reaching another workspace does not exist; it is **denied, not gated**. **A tool name's shape is its scope (two doors):**

- **Workspace tools** are namespaced per workspace as `ws_<id>-<source>__<tool>` — the per-workspace registries, including the platform `nb` source (so `nb__search` is `ws_<id>-nb__search`).
- **Identity tools** (kernel identity sources — `conversations`, `files`, `automations`; see `src/tools/identity-sources.ts`) are **bare** `<source>__<tool>`. They're owned by the user and live OUTSIDE any workspace, so they're NOT composed into workspace registries.

`ws_helix-crm__search` (only when Helix is the session's workspace) and bare `conversations__search` can be invoked in the same conversation.

**The wall is enforced in `routeToolCall`.** A session carries one `workspaceId` (a chat's is its conversation's own workspace; a task's is its provenance workspace; a `/mcp` request's is its validated per-request header). A `ws_<id>-` call whose id == that workspace dispatches into it; any **other** id is `CrossWorkspaceReachDenied`; a session with **no** workspace (e.g. `/mcp`, below) denies all workspace calls with `WorkspaceToolUnavailable`. A bare `<source>__<tool>` routes through the identity door (authorized by ownership via the source's `canAccess`). **There is no per-call membership scan** — the workspace was membership-validated when the session was established (`X-Workspace-Id` middleware for chat; `personalWorkspaceIdFor` is member-by-construction; automation provenance is stamped at create time).

The session's reachable set comes from `runtime.listToolsForWorkspace(wsId)` (that workspace's tools, namespaced, + identity tools); the engine's router and `nb__search` both read it. `nb__search` discovers **only** that workspace — there is no cross-workspace search corpus.

**Skills are walled the same way.** Layer-3 skill selection (`selectRequestLayer3`) loads org-tier (`workDir/skills/`, org-wide), workspace-tier (the conversation's own `wsId` only), and user-tier (`users/<userId>/skills/`) skills — plus **bundle skills** (a connector/app's own `skill://<name>/usage` guidance, synthesized and tool-affinity-matched) from the **conversation's own workspace only**. A bundle installed in another workspace never injects its skill here. No skill crosses a workspace boundary. The **app-aware briefing** is walled the same way: `focusedApp` / `<app-guide>` / `<app-state>` resolve `appContext.serverName` only in the session's bound workspace (`convWsId`), never by scanning the identity's other workspaces — so the prompt never describes an app whose tools the wall would refuse to call.

- **Construct** workspace names only via `namespacedToolName(wsId, name)` from `src/tools/namespace.ts`. **Parse** only via `parseNamespacedToolName(s)` (a name with no `ws_<id>-` prefix is `scope: { kind: "identity" }`). `check:tool-namespace` enforces.
- **Web tier** mirrors the parser at `web/src/lib/namespaced-tool.ts` (regex from `web/src/_generated/workspace-id-pattern.ts`, emitted by `bun run codegen`; `check:codegen` catches drift).
- **Per-call routing** lives in `src/orchestrator/route.ts`. Errors: `UnknownNamespacedToolName` / `CrossWorkspaceReachDenied` / `WorkspaceToolUnavailable` / `UnknownToolSource` / `UnknownIdentitySource` (`WorkspaceAccessDenied` is the base class the wall's two denials share). Both `POST /v1/chat` and `/mcp` map them to identical structured `data.reason` discriminators.
- `BundleRef.oauthScope: "user"` is **deleted from the type union**. Every install binds workspace explicitly via `wsId`; legacy disk records throw `LegacyOAuthScopeError` on load.
- **Dev-mode parity.** The wall works in dev mode (no auth gate); the dev identity flows through the orchestrator the same as a real one. `runtime.requireWorkspaceId()` returns `"_dev"` only when no workspace is in scope.

**`/mcp` is walled to a per-request workspace.** A `/mcp` session has no fixed workspace; each request names its focused workspace via the `X-Workspace-Id` header (the iframe bridge `web/src/bridge/bridge.ts` and the web shell both send it). `McpServerHost.handlePost` validates the caller's membership and threads the workspace through an `AsyncLocalStorage` (`mcpRequestWorkspace`) so the SDK handlers see it: `tools/list` returns that workspace's tools (namespaced) + identity tools, and `tools/call` to any OTHER workspace is `CrossWorkspaceReachDenied`. **Resources are walled the same way** — `resources/list` enumerates only that one workspace's sources, and `resources/read` resolves the caller's identity resources (`files://` etc.) first, then that one workspace, never a sweep across every workspace the identity belongs to. A request with no (or a non-member) `X-Workspace-Id` is identity-only — any `ws_<id>-` call is refused (`WorkspaceToolUnavailable`), and no workspace resources are listed or readable. This keeps the synapse iframe bridge working (it sends its active workspace) while closing the cross-workspace hole: membership-validated, one workspace per request, never a union. Do NOT restore the old cross-workspace `/mcp` union — derive the workspace from the validated header, never from the tool name alone.

### Stage 2 follow-ups — tenant migration order

When migrating a tenant onto Stage 2, run the user-credential migration during a maintenance window with the platform scaled to zero:

1. `bun run migrate:user-creds` — moves `{workDir}/users/<userId>/credentials/...` to `{workDir}/workspaces/ws_user_<userId>/credentials/...`. Idempotent, dry-run by default, shares `.migration-lock` with the Stage 1 scripts. Run **before** deploying the Stage 2 image — the loader throws `LegacyOAuthScopeError` on first read of any unmigrated `oauthScope: "user"` record.
2. Cut traffic to the new build. The first `/mcp` session after the cut allocates an identity-bound session id; the Redis registry schema dropped `workspaceId` (Q4 hard cut) so any in-flight session is harmless to drain.

The full runbook (verification checks, rollback, smoke tests) lives in the Stage 2 deploy runbook.

### Stage 1 follow-ups — tenant migration order

When migrating a tenant onto Stage 1, run the scripts in this order, all during a maintenance window with the platform scaled to zero:

1. `bun run migrate:personal-workspaces` — renames each user's personal workspace to `ws_user_<userId>` and stamps `isPersonal` / `ownerUserId`.
2. `bun run heal:truncated-personal-workspaces` — **only if needed.** Some legacy tenants used a 16-char-truncated slug for personal workspaces that step 1 doesn't recognize. Heuristic: step 1's output shows `no personal workspace found (will be created on next login)` for users who actually do have a workspace named `<displayName>'s Workspace` at a short-slug id. If you see that pattern, run this heal script (dry-run first). Idempotent — safe to run on any tenant; it exits cleanly with `no truncated workspace` when nothing matches. All these scripts share the same `.migration-lock` PID file, so they're serialized by construction.
3. `bun run cleanup:personal-workspace-members` — **only if needed.** Pre-Stage-1.1 data may include multi-admin personal workspaces that the new store invariants reject. Idempotent; dry-run by default, `--apply` to write. A personal workspace missing `ownerUserId` is a hard-error — operator must triage.

### Personal workspace invariants

Personal workspaces (`isPersonal === true`) are sole-owner-by-design. The store enforces four rules and throws `PersonalWorkspaceInvariantError` (`src/workspace/errors.ts`) on violation:

1. **Members locked** to `[{ userId: ownerUserId, role: "admin" }]`. `addMember` / `removeMember` / `updateMemberRole` and `update({ members })` all reject mutations on personal workspaces.
2. **`isPersonal` frozen** post-create (both directions).
3. **`ownerUserId` frozen** on personal workspaces.
4. **`ownerUserId` forbidden** on non-personal workspaces (the two fields travel together).

What stays freely mutable on a personal workspace: `bundles`, `name`, `about`, `customInstructions`. Those are workspace-content edits, not identity edits.

The HTTP layer maps `PersonalWorkspaceInvariantError` to `422 personal_workspace_invariant` with `{ workspaceId, reason }` details (same shape as `ConversationCorruptedError → 422`). The workspace-mgmt tool handlers encode the error into `structuredContent` so it survives the in-process MCP serialization boundary; `handleToolCall` decodes and emits the 422.

## Debug Logging

Hot-path diagnostics are gated behind namespace flags so they're available when you need them without editing source. Use for tracing across the runtime ↔ SSE ↔ browser ↔ iframe chain.

### Server (`NB_DEBUG` environment variable)

```bash
NB_DEBUG=*         bun run dev    # everything
NB_DEBUG=mcp       bun run dev    # MCP source lifecycle + dispatch
NB_DEBUG=sse,mcp   bun run dev    # SSE event flow + MCP
```

`NB_DEBUG` is read once at process start. Changing it mid-session (e.g. `export NB_DEBUG=...` in the running shell) has no effect — restart the process for the new namespaces to take hold.

Namespaces (`src/observability/log.ts`):

| Namespace | Emits | Answers |
|---|---|---|
| `mcp` | McpSource construction; per-call dispatch showing `taskSupport` / `path=task-augmented\|inline` / cached tool count | "Why is my tool going inline vs task-augmented?" "Is my tool cache populated?" |
| `sse` | Every `tool.progress` / `tool.done` entering the runtime sink wrap; every `data.changed` broadcast with client count | "Are progress events reaching the SSE layer?" "Are broadcasts happening, to how many clients?" |
| `auth` | Identity-provider verify rejections at debug volume (the routine, self-healing reasons `no_token` / `token_expired`). Anomalous reasons — `org_mismatch`, `bad_signature`, `jwks_unavailable`, etc. — log at `warn` and need no flag. | "Why is a user being 401'd / involuntarily logged out?" |

Add a namespace by calling `log.debug("ns", "message")` (from `src/observability/log.ts`). Keep this table and the `log.ts` doc comment in sync.

### Bundle subprocess stderr (default-on)

Lines a bundle writes to stderr — Python tracebacks, warnings, application logs — are surfaced verbatim and prefixed `[bundle:<sourceName>]`, dimmed. **No flag required.** This is the bundle author's deliberate diagnostic output, separate from NB's own `NB_DEBUG=mcp` tracing; hiding it costs hours when a bundle crashes (issue #116). To quiet a chatty bundle, silence at the bundle level (logger config) or redirect at the shell (`bun run dev 2> >(grep -v '\[bundle:')`). The last 50 lines are also captured into the `source.crashed` event payload as `stderrTail`, so post-mortem consumers see the cause-of-death.

### Browser (`localStorage.nb_debug`)

```js
localStorage.setItem("nb_debug", "*")        // everything
localStorage.setItem("nb_debug", "sync")     // just the data.changed fan-out
localStorage.removeItem("nb_debug")          // off
```

Reload after setting. Namespaces (`web/src/lib/debug.ts`):

| Namespace | Emits | Answers |
|---|---|---|
| `sync` | Every SSE `data.changed` arrival; parent-side flush with buffer + iframe app names; each `postMessage` forward to a matching iframe | "Is the browser receiving broadcasts?" "Is the iframe I expect actually mounted with the right `data-app`?" |

Namespaces are shared convention between server and browser: `NB_DEBUG=sync` plus `localStorage.nb_debug=sync` together trace the entire data.changed flow.

## Observability (OTel tracing + structured logs)

Vendor-neutral OpenTelemetry lives in `src/observability/`. The runtime depends only on `@opentelemetry/*` and the W3C tracecontext + OTLP wire formats — **never** a branded observability library. The wire is the interface.

- **Spans:** wrap work with `withSpan(name, attrs, fn)` (active-context, nests automatically) — never call the OTel API directly from feature code. Today's spans: `agent.turn` (engine run), `llm.call` (model stream), `tool.dispatch` (MCP dispatch), and the outer HTTP span (Hono middleware, continues an inbound `traceparent`). Add `requestIdentityAttrs()` to span attrs to stamp the verified identity.
- **Propagation:** `injectTraceparent(headers)` on outbound calls that should extend the trace (service-token mint, authenticated remote-MCP fetch). No-op outside a span.
- **Logs:** use `log.*(msg, fields?)` from `src/observability/log.ts` — never raw `console.*` in operational code (it bypasses the JSON/identity/correlation enrichment). With `NB_LOG_FORMAT=json` (set by the chart) lines are structured JSON auto-enriched with `service`, `tenant_id`, `trace_id` (the active OTel trace id — the field the Grafana Loki→Tempo pivot keys on), and identity; pretty dev output is unchanged. `NB_LOG_LEVEL` (default `info`) is the severity floor for info/warn/error; secret-keyed `fields` (a bare `token`, the `*_token` compounds, `secret`/`password`/`api_key`/`authorization`/`cookie`/`credential`) are auto-redacted before write, while LLM usage fields (`inputTokens`/`tokenCount`/…) are preserved. `check:no-raw-console` enforces the logger usage (the console/debug EventSinks are exempt; a rare exception takes a `// lint-ok:console` marker).
- **Trust rule — what may be stamped:** `tenant_id` is a boot-time Resource attribute from `NB_TENANT_ID`, never a request header. `user_id` / `workspace_id` / `conversation_id` come from the verified request context. **Never** stamp the display name, email, secrets, prompts, tool args/results, or file contents.
- **Config:** `OTEL_EXPORTER_OTLP_ENDPOINT` enables export (unset = nothing exported, ids still exist for log correlation — so local dev and OSS checkouts need no infra). `NB_SERVICE_NAME` overrides the service name.
- **OTel deps are exact-pinned to one release train** (stable `sdk-trace-*`/`resources` + the matching experimental exporter). Bump them together or export serialization breaks; the version-coherence test in `test/unit/observability.test.ts` guards it.

## Long-Running Tools (MCP Tasks)

Any MCP tool whose work exceeds the stock MCP request timeout (~60 s) must be written as a **task-augmented tool**. The engine implements the client side of the MCP draft 2025-11-25 `tasks` utility end-to-end; bundle authors only have to opt in.

### Authoring a long-running tool

Declare the tool with `execution.taskSupport` on its `tools/list` entry. FastMCP (Python) makes this one line:

```python
from fastmcp.server.tasks import TaskConfig

@mcp.tool(task=TaskConfig(mode="optional"))
async def start_research(query: str, ctx: Context) -> dict:
    run = app.create_entity("research_run", {...})
    try:
        # phased work; ctx.report_progress(...) on each phase
        # app.update_entity(...) on each phase for live UI
        return {"run_id": run["id"], "report": report}
    except asyncio.CancelledError:
        app.update_entity("research_run", run["id"], {"run_status": "cancelled", ...})
        raise
```

- `mode="optional"` lets the tool run inline or as a task (client decides). Use this.
- `mode="required"` rejects non-augmented calls with JSON-RPC `-32601` — only use if you're certain every client supports tasks.
- `mode="forbidden"` (the implicit default) never runs as a task. Use for fast tools.

### What the engine does automatically

1. On `initialize`, advertises `capabilities.tasks.{requests.tools.call, cancel, list}` so servers know the client supports the task flow. (`src/tools/mcp-source.ts`)
2. When calling a tool whose `execution.taskSupport` is `"optional"` or `"required"`, dispatches through the SDK's streaming API: `client.experimental.tasks.callToolStream(...)`. (`src/tools/mcp-source.ts::callToolAsTask`)
3. Consumes the response stream — `taskCreated` → `taskStatus`* → terminal `result | error` — and emits `tool.progress` events on every `taskStatus` so the chat UI renders live.
4. Run-scoped `AbortSignal` is threaded through `ToolRouter.execute(call, signal)` → `ToolSource.execute(..., signal)` → RequestOptions on the stream. An abort becomes `tasks/cancel` automatically via the SDK.
5. Inline tool calls (taskSupport omitted / forbidden) use the regular `client.callTool(...)` path and the same signal.
6. Crash-retry semantics: **inline calls** restart the subprocess and retry on transport error. **Task-augmented calls do not retry** — task state lives server-side; retrying would create a confusing duplicate. Surfacing the error lets the agent decide whether to initiate a new run.

The spec-compliant task flow does NOT use the 60 s MCP request timeout — `tools/call` returns in milliseconds with a `CreateTaskResult`, and the SDK handles polling internally.

Default TTL attached to outbound task-augmented requests is one hour (`DEFAULT_TASK_TTL_MS` in `src/tools/mcp-source.ts`). Servers may clamp it lower.

### Dual-channel contract (engine + entity)

The task channel is how the **agent** awaits the result. Apps that have UIs should also update a **persistent entity** on each phase transition (via the bundle's state store, typically Upjack). This gives the UI a live view that survives:
- The LLM losing interest mid-run
- The client disconnecting
- The agent process being bounced

Both channels are sources of truth for different consumers. They must be kept in lockstep by the worker:

```
ctx.report_progress(...)  ─► notifications/tasks/status  ─► engine ─► chat UI
app.update_entity(...)    ─► filesystem                   ─► Synapse UI (useDataSync)
```

### Startup reaper pattern

Long-running entities can get orphaned if the bundle subprocess dies mid-run. The canonical fix is a startup sweep that marks any entity stuck in `working` as `failed` with a clear reason. See `synapse-apps/synapse-research/src/mcp_research/server.py::_reap_orphaned_runs()` for the reference implementation.

### Reference bundle

`synapse-apps/synapse-research` is the first consumer of this pattern. Its `tests/test_spec_compliance.py` exercises every MUST from the spec against an in-process FastMCP client and is a good template for new task-aware bundles.

## Prompt Security

`sanitizeLineField()` and XML containment tags in `compose.ts` are prompt injection mitigations. Do not remove without reviewing `test/unit/prompt-injection.test.ts`. The `DELEGATE_PREAMBLE` in `delegate.ts` prevents task-as-system-prompt injection.

**Bundle trust is install-time, not per-prompt.** Do not add `trustScore >= N` gates on any path that injects bundle-authored content into the prompt (skills, app guides, app state, custom instructions). Once a bundle is active in the workspace its tools are already callable, so suppressing the workflow guidance that teaches the model how to use them safely makes the model less safe, not more — and tool descriptions, tool outputs, and `app://instructions` flow through ungated already. The defense is XML containment with `</tag>` escape in the body, the pattern used by `<app-state>`, `<app-guide>`, `<app-instructions>`, `<app-custom-instructions>`, and `<layer3-skill>`. Any new bundle-authored containment tag must escape its own closing form in the body the same way. `trustScore` fields on `FocusedAppInfo` / `AppStateInfo` / `PromptAppInfo` remain for display only.

## API Surfaces — Three Audiences

The platform serves three audiences with three protocol surfaces. They are not tiers; they are distinct contracts for distinct callers, intentionally split.

| Audience | Surface | When |
|---|---|---|
| External MCP clients (Claude Code, Claude Desktop, Cursor, any RFC-conformant client) | `POST /mcp` (Streamable HTTP MCP) | Any caller speaking the MCP protocol from outside the platform. Stateful: server allocates `Mcp-Session-Id` bound to workspace + identity. |
| Iframe widgets (synapse apps in sandboxed `<iframe>`s) | postMessage → `bridge.ts` → MCP SDK Client → `/mcp` | Sandboxed UI talking via the MCP App ext-apps protocol. The bridge is the only iframe path; it shares one `Mcp-Session-Id` per browser tab via a singleton client. |
| Platform's own web shell (first-party React UI: header, settings, chat) | `POST /v1/tools/call`, `POST /v1/resources/read`, `GET /v1/...` (REST) | Trusted same-origin code. Stateless per request: `X-Workspace-Id` header on each fetch; no session, no transport lifecycle. |

> **`/mcp` is walled to a per-request workspace.** A `/mcp` session has no fixed workspace; each request's validated `X-Workspace-Id` bounds it to one workspace (its tools + identity tools), and a call to any other workspace is denied. A request with no/non-member header is identity-only. The iframe bridge (row 2) sends its active workspace on every call, so synapse apps work. See "Workspace tool namespacing — the wall" above.

**Quick decision rules for contributors:**

- Adding a new feature to a settings tab, the chat composer, or anywhere in `web/src/` outside `web/src/bridge/` → use the REST helpers in `web/src/api/client.ts`. Do not import the MCP bridge client.
- Adding a feature to a synapse app (lives in `synapse-apps/<name>/ui/`) → use `@nimblebrain/synapse`'s `callTool` / `callToolAsTask` / `readResource`. The SDK speaks postMessage; the bridge handles the rest.
- Adding a new `nb__*` built-in tool → register it in the engine; both REST and `/mcp` audiences pick it up automatically. Don't add a special endpoint.

**Prefer tool actions over new REST routes.** When the web shell needs a new server-side capability (read installed connectors, save user_config, fetch the OAuth redirect URI, etc.), the default answer is a new **action on an existing platform tool** (e.g., `manage_connectors`, `manage_workspaces`) — not a new `/v1/...` Hono route. A tool action gets routing, auth gating, structured-error handling, and external MCP-client access for free. A new route reinvents all of that and adds surface area to maintain.

The exceptions are real but narrow: add a route only when the endpoint genuinely **can't be a tool call**. Concretely:

- Sets a session-bound cookie that future requests need to present (`/v1/mcp-auth/initiate` sets `nb_oauth_state`).
- Is itself the redirect target of an external flow (`/v1/mcp-auth/callback` is loaded by the vendor's browser, not by our client).
- Streams non-JSON bytes (multipart upload, SSE for the chat stream).
- Serves binary resources or HTML the browser navigates to directly (`/v1/apps/:name/resources/*`).

If none of those apply, write a tool action. A simple JSON read like "what's the OAuth redirect URI?" is a tool action, not a route.

**Why split**, not consolidate: the web shell and external MCP clients have different correctness requirements. The shell is trusted same-origin React with its own React lifecycle; making it speak MCP would force it into stateful session lifecycle (workspace-bound `Mcp-Session-Id`, reset on switch, etc.) for zero gain. Keeping it on stateless REST means workspace switching is a no-op on transport state — next fetch reads the new `X-Workspace-Id` and goes. The bridge needs MCP because external MCP clients also use `/mcp`, so iframes inherit a spec-aligned protocol surface for free.

`/v1/tools/call` and `/v1/resources/read` are NOT being deprecated. They are the platform's first-party API and stay alive indefinitely.

## MCP Session Architecture

Two-layer state model for `/mcp`. Don't merge them.

- **Transport map** (`McpServerHost.transports`): per-process LRU `Map<sessionId, TransportEntry>`. Owns the live `WebStandardStreamableHTTPServerTransport`, the SDK `Server` instance, in-flight JSON-RPC state, and `lastAccessedAt`. Process-bound — never serialize, never share across processes.
- **`SessionRegistry`** (`src/api/session-store/`): pluggable cluster-shared metadata. Stores `{sessionId, identityId, workspaceId, createdAt, lastAccessedAt}` only. **No pod / instance / owner fields** — adding any would leak deployment vocabulary into a metadata interface. Implementations: `InMemorySessionRegistry` (default) and `RedisSessionRegistry`.

Routing requests to the process owning a session's transport is the **load balancer's** job (ALB `lb_cookie` stickiness or header-hash on `Mcp-Session-Id`). The registry doesn't route; it can't move transports.

**Reclamation invariants** — see `mcp-server.ts` file header for the why:

- Idle TTL and LRU-on-capacity both go through `evict(sid, reason)`. **Delete from the map before calling `close()`**, never the reverse — concurrent-request race.
- Same TTL drives both layers (`Runtime.getSessionStoreTtlMs()` → host sweep + registry). One knob.
- Capacity overflow is never a 4xx. A well-formed initialize at `MAX_MCP_SESSIONS` evicts the LRU and is admitted. Do not reintroduce `Too many active sessions`.

**Session-miss `error.data.reason`** has exactly two values:

- `not_found` — registry has no entry (idle-TTL eviction or never created).
- `unavailable` — registry has an entry; this process doesn't have the transport. Don't try to distinguish process-restart from sticky-miss in the response — operators do that via deploy timing + `transport-count vs registry-size` divergence.

**Prerequisites for `platform.replicas > 1`** (all five required):

1. RWX storage or workspace data moved off the PVC. RWO PVC + `RollingUpdate` deadlocks on attach.
2. Routing keyed on `Mcp-Session-Id`. ALB `lb_cookie` stickiness on the platform target group, or NGINX/Envoy header-hash routing.
3. `sessionStore.type: "redis"`. Each tenant gets its own Redis instance in its own namespace (see `infra/CLAUDE.md` per-tenant Redis pattern). Default `nb:mcp:session:` keyPrefix is correct under that model.
4. `platform.strategy.type: RollingUpdate`. Only after (1).
5. `ConnectionRevalidator` gated to a single owner. The connection credential re-validation loop (`src/bundles/connection-revalidator.ts`) polls per-pod in-memory connection state; at `replicas > 1` every pod would poll the same provider account (N× the SaaS API calls against one shared key) and split-brain its flips (pod A flips to `reauth_required` and emits SSE on its own RunBus; pod B still shows `running`). It needs leader election (per-tenant Redis lease) so exactly one owner polls, and the same clustered RunBus as the limitation below to fan the flip out cross-pod. Until then it is single-owner-only — correct at `replicas: 1`, must be coordinated above it.

**Known limitation under `replicas > 1`: RunBus is single-process.** Chat turn replay/resume (the SSE-stream-backed viewer attaches to a per-conversation event log) lives in-memory on the pod that started the turn. A viewer landing on a different pod sees `isActive:false` for an in-flight turn elsewhere and the live frames don't fan out cross-pod. Sticky routing on `Mcp-Session-Id` (prereq #2) mitigates for the active tab; a pod restart or any cross-pod viewer (other tab/device) still drops resume mid-turn. The clustered Redis-backed RunBus is deferred work, tracked in `src/runtime/run-bus.ts` — `serve` warns at boot when `sessionStore.type === "redis"` so the gap is visible. `ConnectionRevalidator` (prereq #5) shares this constraint and the same deferred clustered-RunBus dependency: its `connection.state_changed` flips fan out only on the originating pod's RunBus today.

**Correctly per-pod (NOT a single-owner case): source self-heal.** `BundleLifecycleManager.tryRecoverSource` (the orchestrator's hot-path re-registration of a workspace source that was torn down from the registry without a re-add) and its `recoveryAttempts` negative-cache cooldown are intentionally per-pod in-memory, and that is correct under `replicas > 1`. It guards a per-pod resource — `registriesByWs` is process-local and its sources are process-bound transports — so each pod must heal its own registry on its own miss. Unlike `ConnectionRevalidator`, it is reactive and idempotent (`hasSource` short-circuit, re-uses persisted OAuth state), touches no shared upstream account, and fans out to nobody, so it needs no leader election. Do NOT move the cooldown to Redis: a cluster-shared stamp would let one pod's failed heal suppress another pod's legitimate independent miss.

**Connection credential re-validation (`ConnectionRevalidator`).** A runtime-owned timer (sibling of `HealthMonitor`, started in `serve`) that detects connectors whose upstream authorization lapsed *without* a transport 401 — managed-MCP providers (Composio) whose downstream vendor account expires while the platform→provider key stays valid. It polls each provider through a generic `ConnectionHealthProbe` (`src/bundles/connection-probe.ts`; Composio's impl is `src/composio/connection-probe.ts`) and flips `running → reauth_required` after N consecutive `credential_lost` verdicts (anti-flap; any API error/timeout is `indeterminate` = no-op; a flap-storm trips a circuit breaker that keeps all state). Dormant unless a probe is registered (Composio configured). Operator knobs (env, read once at startup, restart to change): `COMPOSIO_MONITOR_ENABLED` (incident kill switch, default on when `COMPOSIO_API_KEY` is set) and `COMPOSIO_MONITOR_INTERVAL_SECONDS` (default 300). Does NOT touch transports/restart/`dead` — that stays `HealthMonitor`'s job (liveness-of-process vs. liveness-of-credential, two disjoint loops).

**TTL units: seconds at the surface, ms internally.** Operator-facing: `MCP_SESSION_TTL_SECONDS` env (highest priority) > `sessionStore.ttlSeconds` config > 8h default. Conversion to ms happens in `Runtime.getSessionStoreTtlMs()` only — registry constructors and the host's idle sweep both take ms from there. Don't add mixed-unit code elsewhere.

## MCP App Bridge Rules

These cause production bugs if violated:

- `tools/call` must return `CallToolResult` as-is (never unwrap fields)
- `POST /v1/tools/call` must NOT emit `data.changed` SSE events (causes infinite loops)
- Picker uploads (`synapse/request-file`) MUST persist via `POST /v1/resources` (multipart); iframes receive a `FileEntry`, never bytes. Base64-in-`tools/call` arguments hits the 1 MB JSON cap and silently breaks for any binary above ~750 KB.
- Tool errors (`isError: true`) must become JSON-RPC `error` responses
- Bridge must guard listeners with `destroyed` flag (React StrictMode double-mounts)
- `SlotRenderer` effect depends only on `placementKey` (callbacks via refs, not deps)
- Shell components must not consume `ChatContext` (use `ChatConfigContext` instead)
- The chat panel is **workspace-scoped**: `ChatProvider` (`web/src/context/ChatContext.tsx`) watches the route-derived focus workspace and, on a real workspace→workspace switch, clears the open conversation via the narrow `newConversation()` (a fresh draft slice) — NOT `chatStore.reset()` (that is the identity-change broad reset). A conversation belongs to one workspace, so the panel doesn't carry it into another. `null` focus (home/identity routes) is held, not reset, so `A→home→A` keeps context while `A→B` re-scopes. Opening a conversation from within its own workspace doesn't change focus, so it isn't cleared.
- `setAuthToken` in `web/src/api/client.ts` fires a registered lifecycle handler on real changes only (equality-guarded). The bridge MCP client registers `resetMcpBridgeClient` here at module load to drop its identity-bound session on logout. `setActiveWorkspaceId` is also equality-guarded but does NOT fire the handler — per Stage 2 / Q3 the `/mcp` session is identity-bound, so workspace switches reuse the same session and dispatch context via the per-request `X-Workspace-Id` header. Stateless callers (REST helpers) read the current values per-request and need no hook.

## Auto-Generated Files

Do not edit these manually:

- `bun.lock`, `web/bun.lock` — lock files, managed by `bun install`
- `web/dist/` — Vite build output, regenerated by `bun run build`
- `src/bundles/schemas/*.schema.json` — vendored MCPB JSON Schemas (v0.3, v0.4)
- `web/src/_generated/platform-schemas/` — TypeScript declarations derived from `src/tools/platform/schemas/`. Regenerate with `bun run codegen` after editing any source schema. CI verifies via `bun run check:codegen` (part of `verify:static`); drift is a build failure.

## Config Schema

`src/config/nimblebrain-config.schema.json` is the **canonical source** for the
`nimblebrain.json` config schema — edit it here. The runtime validates against it at
startup, and `.github/workflows/schema-deploy.yml` publishes it to
`schemas.nimblebrain.ai` (S3 + CloudFront invalidation) on push to `main` when it
changes. It must stay in lockstep with the runtime feature surface in
`src/config/features.ts`; `test/unit/config-schema-drift.test.ts` fails the build on
drift. (Previously this file was fetched from S3 at `postinstall`; that indirection
is removed — the repo is now upstream of the published artifact, not downstream.)

## Releasing

See [RELEASING.md](./RELEASING.md) for the prescriptive release runbook. When the user asks to cut a release, follow that document literally — it covers tagging conventions (semver with `v` prefix, hyphen = pre-release), the step-by-step procedure, the verification checklist, and rollback. Releases are cut by pushing an annotated git tag matching `v*`; `.github/workflows/release.yml` does the rest. Do not bump `package.json` per release.

## Full Architecture

See `README.md` for complete architecture documentation, API reference, configuration, deployment, and CLI details.
