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
| Model | `claude-sonnet-4-5-20250929` |
| Max iterations | 10 (hard cap: 25) |
| Max input tokens | 500,000 |
| Max output tokens | 16,384 |
| Default bundles | none (platform capabilities are built in) |
| Work directory | `~/.nimblebrain` |
| API port | 27247 |
| Web port | 27246 |

## Workspace Isolation

All tool handlers that access data must be workspace-scoped. Use `runtime.requireWorkspaceId()` (never `getCurrentWorkspaceId()`). In dev mode it returns `"_dev"` — no special-case logic needed.

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

## Full Architecture

See `README.md` for complete architecture documentation, API reference, configuration, deployment, and CLI details.
