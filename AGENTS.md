# NimbleBrain

Self-hosted platform for MCP Apps and agent automations, built on Bun. Agentic loop + MCP bundle management + interactive UI host + cron-scheduled automations + skill-driven prompt composition + HTTP API + web client.

## Build & Verify

```bash
bun install                # Install dependencies
bun run dev                # API (:27247) + Web (:27246) with watch/HMR
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
```

**Before opening a PR, run `bun run verify`.** It is the single command that mirrors CI, enforced by construction: `.github/workflows/ci.yml` invokes only `verify:*` subscripts (plus `test:integration` and `smoke`) — no inline check steps. To add or change a check, edit the matching subscript in `package.json`; CI picks it up automatically. If CI ever catches something `verify` didn't, the fix is to update the subscript, not the checklist. Tool-level parity is the gate; discipline-level rules are not.

## Conventions

- **Runtime:** Bun (not Node). Use `bun run`, `bun test`, `bunx`.
- **Module system:** ESM only. All imports use `.ts` extensions.
- **Linting:** Biome (not ESLint/Prettier). Run `bun run lint`.
- **Type checking:** `bunx tsc --noEmit`. Strict mode enabled.
- **HTTP framework:** Hono for routing and middleware. Typed context via `AppEnv`/`AuthEnv`.
- **Model types:** Use Vercel AI SDK V3 types (`LanguageModelV3`, `LanguageModelV3Message`, etc.) from `@ai-sdk/provider`. The engine calls `model.doStream()` directly.
- **No classes for data** — plain interfaces + factory functions preferred.
- **Tool results:** Return typed data in `structuredContent`, use `content` only for human-readable summary.
- **Errors:** Tool errors are caught per-call and returned as `isError: true` results. Engine errors surface via `run.error` event.
- **Documentation:** User- and operator-facing docs live at [docs.nimblebrain.ai](https://docs.nimblebrain.ai). Do NOT add new docs to this repo. `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `AGENTS.md`/`CLAUDE.md` are the standard OSS files that stay here; anything else that describes how to configure, deploy, or use NimbleBrain belongs on the docs site. Cross-link from this `README.md` into the docs site instead of duplicating content.

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

## MCP App Bridge Rules

These cause production bugs if violated:

- `tools/call` must return `CallToolResult` as-is (never unwrap fields)
- `POST /v1/tools/call` must NOT emit `data.changed` SSE events (causes infinite loops)
- Tool errors (`isError: true`) must become JSON-RPC `error` responses
- Bridge must guard listeners with `destroyed` flag (React StrictMode double-mounts)
- `SlotRenderer` effect depends only on `placementKey` (callbacks via refs, not deps)
- Shell components must not consume `ChatContext` (use `ChatConfigContext` instead)

## Auto-Generated Files

Do not edit these manually:

- `bun.lock`, `web/bun.lock` — lock files, managed by `bun install`
- `web/dist/` — Vite build output, regenerated by `bun run build`
- `src/bundles/schemas/*.schema.json` — vendored MCPB JSON Schemas (v0.3, v0.4)
- `src/config/nimblebrain-config.schema.json` — generated at build time

## Releasing

See [RELEASING.md](./RELEASING.md) for the prescriptive release runbook. When the user asks to cut a release, follow that document literally — it covers tagging conventions (semver with `v` prefix, hyphen = pre-release), the step-by-step procedure, the verification checklist, and rollback. Releases are cut by pushing an annotated git tag matching `v*`; `.github/workflows/release.yml` does the rest. Do not bump `package.json` per release.

## Full Architecture

See `README.md` for complete architecture documentation, API reference, configuration, deployment, and CLI details.
