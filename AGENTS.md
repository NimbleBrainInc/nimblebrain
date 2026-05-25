# NimbleBrain

> This file is read by agents. Keep edits terse, imperative, token-aware. No long-form prose; bullets with concrete triggers and examples.

Self-hosted platform for MCP Apps and agent automations, built on Bun. Agentic loop + MCP bundle management + interactive UI host + cron-scheduled automations + skill-driven prompt composition + HTTP API + web client.

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

**Before opening a PR, run `bun run verify`.** It is the single command that mirrors CI, enforced by construction: `.github/workflows/ci.yml` invokes only `verify:*` subscripts (plus `test:integration` and `smoke`) — no inline check steps. To add or change a check, edit the matching subscript in `package.json`; CI picks it up automatically. If CI ever catches something `verify` didn't, the fix is to update the subscript, not the checklist. Tool-level parity is the gate; discipline-level rules are not.

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
- **Documentation:** User- and operator-facing docs live at [docs.nimblebrain.ai](https://docs.nimblebrain.ai). Do NOT add new docs to this repo. `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `AGENTS.md`/`CLAUDE.md` are the standard OSS files that stay here; anything else that describes how to configure, deploy, or use NimbleBrain belongs on the docs site. Cross-link from this `README.md` into the docs site instead of duplicating content.
- **Per-directory agent docs:** any `AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it (`ln -s AGENTS.md CLAUDE.md`). Edit `AGENTS.md`. New per-directory docs follow the same pattern. Don't invert it (real `CLAUDE.md` + symlinked `AGENTS.md`) — it confuses tools that prefer one or the other.
- **CHANGELOG entries must be terse and scannable.** Target ~250–350 words per release (not per entry). Structure: short `### Highlights` with 3–5 one-sentence bullets, then `### Breaking` / `### Added` / `### Changed` / `### Fixed` / `### Removed`. One line per bullet; link to docs or the PR for depth instead of explaining implementation inline. Include migration-required operator actions (e.g. "run `scripts/migrate-tenant-files.ts`") in Fixed/Breaking. Cut internal refactors, release-pipeline polish, CI tweaks, and per-PR credit noise — they belong in `git log`, not the CHANGELOG. If a bullet needs more than one sentence to explain *what* changed and *why a reader cares*, either (a) link out or (b) rethink whether the reader needs this entry at all.

## Testing

Tests use `createEchoModel()` from `test/helpers/echo-model.ts` and `StaticToolRouter` to avoid LLM calls. No mocking of LLM providers needed.

Tests are organized into three tiers:

| Tier | Directory | Command | What belongs here |
|------|-----------|---------|-------------------|
| Unit | `test/unit/` | `bun run test:unit` | Pure logic, mocked deps, no I/O or servers |
| Integration | `test/integration/` | `bun run test:integration` | `Runtime.start()`, HTTP servers, real crypto, subprocesses |
| Smoke | `test/smoke/` | `bun run smoke` | Real MCP server spawns, network calls |
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
├── cli/           CLI (Commander.js) + TUI (Ink/React)
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

When adding a new code path that touches workspace-scoped credentials or identity, match the existing precedent: **hard-error on missing `wsId`, don't silently default**. `startBundleSource`'s named-bundle branch throws; the URL-bundle branch does too (for OAuth-provider paths). A `?? "ws_default"` fallback would pool credentials across tenants.

**Credentials live in the workspace, not the user.** Post-Stage-2 every credential file is reachable at `{workDir}/workspaces/<wsId>/credentials/...` and is constructed only through `WorkspaceContext` (via `runtime.getWorkspaceContext(wsId)`) or the primitives in `src/config/workspace-credentials.ts`. The pre-Stage-2 layout `{workDir}/users/<userId>/credentials/...` is fully deleted from the read path — the loader at `src/bundles/lifecycle.ts::assertBundleRefIsPostStage2` throws `LegacyOAuthScopeError` on any disk record carrying `oauthScope: "user"`, and operators must run `bun run migrate:user-creds` before deploying (see `nimblebrain-ops/research/delegation-model/STAGE_2_DEPLOY.md`). User-personal credentials live in the user's personal workspace at `{workDir}/workspaces/ws_user_<userId>/credentials/...` — the same code path serves them. `users/<userId>/...` is reserved for non-credential per-user data (currently `users/<userId>/skills/`); future per-user data follows the same convention. Hand-building `join(workDir, "users", userId, "credentials", ...)` paths is a regression caught by `check:credential-paths`.

**Conversations are user-scoped, not workspace-scoped.** Post-Stage-1, every conversation lives at `{workDir}/conversations/{convId}.jsonl` and is authorized by ownership (`Conversation.ownerId === access.userId`). Look up via `runtime.findConversation(convId, { userId })`; write via `runtime.findConversationStore()`. `workspaceId` on conversation metadata is a tool-scoping breadcrumb — it tells the runtime which workspace's tools the chat had access to when a turn ran, NOT where the file lives. Hand-building per-workspace conversation paths (`join(workDir, "workspaces", wsId, "conversations", ...)`) is a regression caught by `check:conversation-paths`. **Personal workspace ids** go through `personalWorkspaceIdFor(userId)` from `src/workspace/workspace-store.ts` — no hand-built `"ws_user_" + userId` or `` `ws_user_${userId}` `` outside that helper (`check:personal-workspace-id` enforces).

### Cross-workspace tool namespacing (Stage 2)

Sessions — chat and `/mcp` — are **identity-bound, not workspace-bound**. A user's tool list aggregates across every workspace they belong to. **What ships today: every tool is namespaced per workspace** as `ws_<id>-<source>__<tool>` — the aggregator namespaces *all* sources in each per-workspace registry, including the platform `nb` source (so `nb__search` surfaces as `ws_<id>-nb__search`, never bare). `ws_helix-crm__search` and `ws_user_<id>-conversations__search` can be invoked in the same conversation.

The name *grammar* also recognizes a **bare/global scope** (a name with no `ws_<id>-` prefix parses to `{ kind: "global" }`), intended for platform + identity-owned singletons. **Global dispatch is not yet wired** — `routeToolCall` fail-closes a bare name with `GlobalScopeNotRoutable`, deferred to a later stage. Until then, treat every shipped tool name as workspace-namespaced; a bare name is a client error, not a valid call.

- **Construct** workspace names only via `namespacedToolName(wsId, name)` from `src/tools/namespace.ts`. **Parse** only via `parseNamespacedToolName(s)` (returns `{ scope, toolName }`; a name with no `ws_<id>-` prefix is `scope: global`). Hand-building or hand-parsing a namespaced name is a regression caught by `check:tool-namespace`.
- **Web tier** mirrors the parser at `web/src/lib/namespaced-tool.ts` (web can't import from `src/`). The web parser's regex is built from `WORKSPACE_ID_PATTERN` / `WORKSPACE_ID_FLAGS` in `web/src/_generated/workspace-id-pattern.ts`, emitted from `src/workspace/workspace-id-pattern.ts` by `bun run codegen`. `check:codegen` catches drift; a regex-equality test in `web/test/namespaced-tool.test.ts` pins the contract.
- **Per-call routing** lives in `src/orchestrator/` — parse `ws_<id>-<name>` → construct `WorkspaceContext(id)` → dispatch. Errors flow as `UnknownNamespacedToolName` / `UnknownWorkspace` / `WorkspaceAccessDenied` / `UnknownToolSource` / `GlobalScopeNotRoutable` (bare/global names, until global dispatch lands); both the chat REST surface (`POST /v1/chat`) and the `/mcp` JSON-RPC surface map them to identical structured `data.reason` discriminators.
- `BundleRef.oauthScope: "user"` is **deleted from the type union** (Stage 2 / T008). Every install binds workspace explicitly via `wsId`; legacy disk records throw `LegacyOAuthScopeError` on load with an operator-actionable message naming the migration script.
- **Dev-mode parity.** Identity-bound sessions work in dev mode (no auth gate); the dev identity flows through the orchestrator the same as a real one. `runtime.requireWorkspaceId()` returns `"_dev"` only when no workspace is in scope — cross-workspace dispatch routes through the same code path.

### Stage 2 follow-ups — tenant migration order

When migrating a tenant onto Stage 2, run the user-credential migration during a maintenance window with the platform scaled to zero:

1. `bun run migrate:user-creds` — moves `{workDir}/users/<userId>/credentials/...` to `{workDir}/workspaces/ws_user_<userId>/credentials/...`. Idempotent, dry-run by default, shares `.migration-lock` with the Stage 1 scripts. Run **before** deploying the Stage 2 image — the loader throws `LegacyOAuthScopeError` on first read of any unmigrated `oauthScope: "user"` record.
2. Cut traffic to the new build. The first `/mcp` session after the cut allocates an identity-bound session id; the Redis registry schema dropped `workspaceId` (Q4 hard cut) so any in-flight session is harmless to drain.

The full runbook (verification checks, rollback, smoke tests) lives in `nimblebrain-ops/research/delegation-model/STAGE_2_DEPLOY.md`.

### Stage 1 follow-ups — tenant migration order

When migrating a tenant onto Stage 1, run the scripts in this order, all during a maintenance window with the platform scaled to zero:

1. `bun run migrate:personal-workspaces` — renames each user's personal workspace to `ws_user_<userId>` and stamps `isPersonal` / `ownerUserId`.
2. `bun run migrate:conversations-to-top-level` — moves per-workspace conversations to `{workDir}/conversations/`.
3. `bun run heal:truncated-personal-workspaces` — **only if needed.** Some legacy tenants used a 16-char-truncated slug for personal workspaces that step 1 doesn't recognize. Heuristic: step 1's output shows `no personal workspace found (will be created on next login)` for users who actually do have a workspace named `<displayName>'s Workspace` at a short-slug id. If you see that pattern, run this heal script (dry-run first). Idempotent — safe to run on any tenant; it exits cleanly with `no truncated workspace` when nothing matches. All three scripts share the same `.migration-lock` PID file, so they're serialized by construction.
4. `bun run cleanup:personal-workspace-members` — **only if needed.** Pre-Stage-1.1 data may include multi-admin personal workspaces that the new store invariants reject. Idempotent; dry-run by default, `--apply` to write. A personal workspace missing `ownerUserId` is a hard-error — operator must triage.

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

Namespaces (`src/cli/log.ts`):

| Namespace | Emits | Answers |
|---|---|---|
| `mcp` | McpSource construction; per-call dispatch showing `taskSupport` / `path=task-augmented\|inline` / cached tool count | "Why is my tool going inline vs task-augmented?" "Is my tool cache populated?" |
| `sse` | Every `tool.progress` / `tool.done` entering the runtime sink wrap; every `data.changed` broadcast with client count | "Are progress events reaching the SSE layer?" "Are broadcasts happening, to how many clients?" |

Add a namespace by calling `log.debug("ns", "message")` (from `src/cli/log.ts`). Keep this table and the `log.ts` doc comment in sync.

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

**Prerequisites for `platform.replicas > 1`** (all four required):

1. RWX storage or workspace data moved off the PVC. RWO PVC + `RollingUpdate` deadlocks on attach.
2. Routing keyed on `Mcp-Session-Id`. ALB `lb_cookie` stickiness on the platform target group, or NGINX/Envoy header-hash routing.
3. `sessionStore.type: "redis"`. Each tenant gets its own Redis instance in its own namespace (see `infra/CLAUDE.md` per-tenant Redis pattern). Default `nb:mcp:session:` keyPrefix is correct under that model.
4. `platform.strategy.type: RollingUpdate`. Only after (1).

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
- `setAuthToken` in `web/src/api/client.ts` fires a registered lifecycle handler on real changes only (equality-guarded). The bridge MCP client registers `resetMcpBridgeClient` here at module load to drop its identity-bound session on logout. `setActiveWorkspaceId` is also equality-guarded but does NOT fire the handler — per Stage 2 / Q3 the `/mcp` session is identity-bound, so workspace switches reuse the same session and dispatch context via the per-request `X-Workspace-Id` header. Stateless callers (REST helpers) read the current values per-request and need no hook.

## Auto-Generated Files

Do not edit these manually:

- `bun.lock`, `web/bun.lock` — lock files, managed by `bun install`
- `web/dist/` — Vite build output, regenerated by `bun run build`
- `src/bundles/schemas/*.schema.json` — vendored MCPB JSON Schemas (v0.3, v0.4)
- `src/config/nimblebrain-config.schema.json` — generated at build time
- `web/src/_generated/platform-schemas/` — TypeScript declarations derived from `src/tools/platform/schemas/`. Regenerate with `bun run codegen` after editing any source schema. CI verifies via `bun run check:codegen` (part of `verify:static`); drift is a build failure.

## Releasing

See [RELEASING.md](./RELEASING.md) for the prescriptive release runbook. When the user asks to cut a release, follow that document literally — it covers tagging conventions (semver with `v` prefix, hyphen = pre-release), the step-by-step procedure, the verification checklist, and rollback. Releases are cut by pushing an annotated git tag matching `v*`; `.github/workflows/release.yml` does the rest. Do not bump `package.json` per release.

## Full Architecture

See `README.md` for complete architecture documentation, API reference, configuration, deployment, and CLI details.
