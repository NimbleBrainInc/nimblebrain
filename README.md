# NimbleBrain

[![CI](https://github.com/NimbleBrainInc/nimblebrain/actions/workflows/ci.yml/badge.svg)](https://github.com/NimbleBrainInc/nimblebrain/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/NimbleBrainInc/nimblebrain/blob/main/LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![MCP](https://img.shields.io/badge/protocol-MCP-8A2BE2)](https://modelcontextprotocol.io)

A self-hosted platform for [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) and agent automations. Install an MCP bundle and you get more than tools — you get an interactive UI in the sidebar with live agent-UI data sync, and the ability to run the agent on demand or on a cron schedule. Full [ext-apps](https://apps.extensions.modelcontextprotocol.io/api/) host support on top of an agentic loop with skill-driven prompt composition and multi-agent delegation.

Ships as container images. Also exposes itself as an MCP server via Streamable HTTP so external MCP clients can consume the aggregated toolset.

## Quick Start

### Option 1: Docker (recommended)

```bash
# Prerequisites: Docker
export ANTHROPIC_API_KEY=sk-ant-...

docker compose up --build
# Web UI:  http://localhost:27246
# API:     http://localhost:27246/v1/health
```

Open `http://localhost:27246` in your browser. Auth is configured via `instance.json` (see Configuration).

### Option 2: Local development

```bash
# Prerequisites: Bun (https://bun.sh), mpak CLI (https://mpak.dev), Node.js 22+
export ANTHROPIC_API_KEY=sk-ant-...

bun install
cd web && bun install && cd ..
bun run dev
# API on http://localhost:27247 (auto-restarts on file changes)
# Web on http://localhost:27246 (Vite HMR, proxies /v1/* to :27247)
```

One command, one terminal. Output is prefixed `[api]` / `[web]`. Ctrl+C stops both.

For API-only development (no web client):

```bash
bun run dev:api
```

### Option 3: CLI only (no web)

```bash
bun install
bun run dev:tui    # Interactive TUI (Ink)
```

## How It Works

```
User message
    │
    ▼
┌─────────────────────────────────────────┐
│ Runtime.chat()                          │
│                                         │
│  1. Skill matching (triggers → keywords)│
│  2. System prompt composition           │
│  3. Tool filtering (per-skill scoping)  │
│  4. AgentEngine loop:                   │
│     LLM call → tool execution → repeat  │
│  5. Conversation persistence            │
└─────────────────────────────────────────┘
    │
    ▼
ChatResult { response, toolCalls, tokens, ... }
```

The engine loops until the model stops calling tools, hits the iteration limit (default 10, max 25), or exceeds the token budget.

## How to Test and Verify

```bash
bun install
bun run verify           # lint → typecheck → test → test:web → smoke

# Or individually:
bun run test             # Unit + integration tests
bun run lint             # Biome linter
bun run check            # TypeScript strict mode

# Web client — build verification
cd web && bun install
bun run build            # TypeScript + Vite build → dist/

# Docker — validate configs
docker compose config    # Validate compose file
```

## HTTP API

All endpoints require authentication (Bearer token or session cookie) unless noted. Auth is configured via `instance.json` — see the identity system docs.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /v1/health | No | Health check |
| GET | /v1/bootstrap | Yes | Bootstrap workspace context (user, workspaces, shell config) |
| POST | /v1/chat | Yes | Synchronous chat |
| POST | /v1/chat/stream | Yes | SSE streaming chat |
| GET | /v1/apps/:name/resources/:path | Yes | Fetch app UI resource |
| POST | /v1/tools/call | Yes | Direct tool invocation |
| GET | /v1/shell | Yes | Shell configuration (placements, endpoints) |
| GET | /v1/files/:fileId | Yes | Serve uploaded file |
| GET | /v1/events | Yes | SSE workspace event stream |
| GET | /v1/auth/authorize | No | OAuth authorization redirect |
| GET | /v1/auth/callback | No | OAuth callback handler |
| POST | /v1/auth/logout | Yes | Clear session cookie |
| POST | /v1/auth/refresh | No | Refresh access token |
| GET | /.well-known/oauth-protected-resource | No | MCP OAuth discovery (RFC 9728) |
| GET | /.well-known/oauth-authorization-server | No | AuthKit metadata proxy (RFC 8414) |
| POST/GET/DELETE | /mcp | Yes | Streamable HTTP MCP server endpoint |

## Architecture

NimbleBrain is both an MCP **client** (connecting to installed bundles via stdio/HTTP) and an MCP **server** (exposing composed tools to external hosts via the `/mcp` Streamable HTTP endpoint). The `ToolRegistry` aggregates tools from all connected MCP servers into a single namespace, while skills scope tool access per task.

Three port interfaces isolate concerns:

| Port | Purpose | Implementations |
|------|---------|----------------|
| `ModelPort` | LLM provider | `AnthropicModelAdapter` (prompt caching), `EchoModelAdapter` (tests) |
| `ToolRouter` | Tool discovery + execution | `ToolRegistry` (MCP sources + inline sources), `StaticToolRouter` (tests) |
| `EventSink` | Observability | `StructuredLogSink`, `WorkspaceLogSink`, `SseEventManager`, `ConsoleEventSink`, `CallbackEventSink`, `DebugEventSink`, `NoopEventSink` |

### System Tools

All system tools are prefixed with `nb__` (the `nb` source name + `__` separator).

| Tool | Purpose |
|-----------|---------|
| `nb__status` | Platform status: overview, bundles, skills, or config (scope param) |
| `nb__search` | Unified search: installed tools or mpak registry (scope param) |
| `nb__set_model_config` | Update model provider and limits (admin only) |
| `nb__set_preferences` | Set user preferences (name, timezone, theme) |
| `nb__manage_app` | Install, uninstall, or configure an app |
| `nb__manage_skill` | Create, edit, delete user skills |
| `nb__delegate` | Spawn child agent for sub-tasks (multi-agent) |
| `nb__briefing` | Generate personalized activity briefing |
| `nb__manage_users` | Create or delete users (admin only) |
| `nb__manage_workspaces` | Workspace CRUD + member management + conversation sharing (admin only) |

Additional internal tools (UI-only, hidden from LLM) are listed in [Architecture Reference](#internal-system-tools-ui-only-hidden-from-llm).

### Skills

Skills are markdown files with YAML frontmatter. They inject system prompts and scope tool access:

```yaml
---
name: my-skill
description: What this skill does
metadata:
  triggers: ["exact phrase match"]
  keywords: [fuzzy, keyword, matching]
  category: domain
allowed-tools: ["server__*"]
---

# System prompt content injected when this skill matches
```

Skill matching is two-phase:
1. **Triggers** — exact substring match on the user message (first hit wins)
2. **Keywords** — count keyword hits, require minimum 2 to qualify

Two categories of skills:
- **Core** (`src/skills/core/`) — always injected into the system prompt (e.g., `bootstrap.md` teaches meta-tool usage)
- **User-matchable** — loaded from `src/skills/builtin/` (currently empty), `~/.nimblebrain/skills/`, and config-specified directories

### Bundles

Bundles are [MCPB](https://github.com/modelcontextprotocol/mcpb)-format MCP servers. They can be:

- **Named** — downloaded and cached via `mpak run @scope/name`
- **Local** — resolved from a path on disk
- **Remote** — connected via Streamable HTTP or SSE transport (distributed MCP servers)

Local and named bundles spawn as subprocesses communicating via stdio (MCP JSON-RPC 2.0). Remote bundles connect over HTTP. All three types are aggregated into the same unified tool namespace by the `ToolRegistry`.

No MCP bundles are installed by default. Platform capabilities (home, conversations, files, settings, usage, automations) are built in as inline tool sources (see `src/tools/platform/`). Install bundles explicitly via the mpak registry or a local path. Tool visibility follows the tiered surfacing rules described under [Tiered Tool Surfacing](#tiered-tool-surfacing).

## Configuration

Create a `nimblebrain.json` in your working directory:

```json
{
  "model": { "provider": "anthropic" },
  "defaultModel": "claude-sonnet-4-5-20250929",
  "bundles": [
    { "name": "@scope/bundle-name" },
    { "name": "@scope/bundle-name", "env": { "API_KEY": "..." }, "trustScore": 92,
      "ui": { "name": "My App", "icon": "✓", "primaryView": { "resourceUri": "ui://myapp/main" } } },
    { "path": "/local/path/to/bundle" }
  ],
  "skillDirs": ["/path/to/skills"],
  "http": { "port": 27247, "host": "127.0.0.1" },
  "agents": {
    "researcher": {
      "description": "Research agent",
      "systemPrompt": "You are a research agent...",
      "tools": ["search__*"],
      "maxIterations": 8
    }
  },
  "features": { ... },
  "maxIterations": 10,
  "maxOutputTokens": 16384,
  "workDir": "~/.nimblebrain"
}
```

Feature flags control which system capabilities are enabled. All default to `true`. See [Feature Flags](#feature-flags) for the full list.

### CLI Commands

```
nb                          Interactive TUI (default) / headless pipe mode
nb serve                    HTTP API server (production)
nb dev                      Dev mode: API with file watching + web HMR
nb bundle list|add|remove|search   Manage bundles
nb skill list|info          Inspect skills
nb config set|get|clear     Configure bundle settings
nb status                   Workspace status
nb reload                   Hot-reload bundles and config
nb telemetry on|off|status|reset   Manage anonymous telemetry
nb automation               Manage automation rules
```

Run `nb --help` or `nb <command> --help` for full usage. If you haven't run `bun link`, use `bun run src/cli/index.ts` instead of `nb`.

### CLI Flags

| Flag | Scope | Purpose |
|------|-------|---------|
| `--config <path>` | Global | Config file (default: `./nimblebrain.json`) |
| `--model <id>` | Global | Override default model |
| `--workdir <path>` | Global | Override working directory |
| `--debug` | Global | Enable debug event logging |
| `--help` | Global | Print help and exit |
| `--json` | Headless + subcommands | Structured JSON output |
| `--resume <id>` | TUI/headless | Resume a previous conversation |
| `--port <number>` | serve, dev | HTTP server port (default: 27247) |
| `--no-web` | dev | Skip web dev server (API only) |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required unless set in config) |
| `NB_WORK_DIR` | Override working directory (takes precedence over config, not `--workdir`) |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins (for cookie-based auth) |
| `MCP_MAX_SESSIONS` | Max concurrent MCP sessions (default: 100) |
| `MCP_SESSION_TTL_MS` | MCP session inactivity TTL in ms (default: 1800000) |

## Headless / Pipe Mode

When stdin is not a terminal (piped), the CLI runs in headless mode:

```bash
echo "What is 2 + 2?" | bun run dev:tui

# Multi-turn (conversation carried across lines)
printf "Hello\nWhat did I just say?\n" | bun run dev:tui

# Structured JSON output
echo "List files" | bun run dev:tui -- --json
```

Each line of stdin is one message. The conversation ID is carried across lines automatically. Responses go to stdout (plain text by default, JSON objects with `--json`). Logs go to stderr. EOF exits cleanly.

## Programmatic API

```typescript
import { Runtime } from "nimblebrain";

const runtime = await Runtime.start({
  model: { provider: "anthropic" },
  store: { type: "memory" },
});

const result = await runtime.chat({ message: "What can you help me with?" });
console.log(result.response);

await runtime.shutdown();
```

### Key Types

```typescript
interface ChatRequest {
  message: string;
  conversationId?: string;  // Resume existing conversation
  model?: string;           // Override model for this request
  maxIterations?: number;   // Override iteration limit
  workspaceId?: string;     // Target workspace
  fileRefs?: FileReference[];  // Attached files for context
  contentParts?: ContentPart[];
  metadata?: Record<string, unknown>;
}

interface ChatResult {
  response: string;
  conversationId: string;
  workspaceId?: string;
  skillName: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: string;
    ok: boolean;
    ms: number;
  }>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  usage: TurnUsage;
}
```

## Project Structure

```
src/
├── index.ts              Public API exports
├── engine/               Agentic loop (model → tool → repeat)
│   ├── engine.ts         AgentEngine class
│   ├── types.ts          ModelPort, ToolRouter, EventSink interfaces
│   ├── tasks.ts          MCP Tasks client (polling, progress, cancellation)
│   └── cost.ts           Token cost estimation by model
├── runtime/              High-level orchestration
│   ├── runtime.ts        Runtime.start() → runtime.chat()
│   ├── types.ts          RuntimeConfig, ChatRequest, ChatResult
│   ├── tools.ts          filterTools (skill-scoped tool filtering)
│   ├── features.ts       Feature flags resolution and tool gating
│   ├── env-filter.ts     Bundle env var allowlist/filter
│   └── workspace-runtime.ts  Per-workspace bundle spawning
├── identity/             Authentication adapters
│   ├── provider.ts       IdentityProvider interface, UserIdentity type
│   ├── providers/dev.ts  Dev mode (no auth)
│   ├── providers/oidc.ts OIDC provider (JWT verification)
│   ├── providers/workos.ts WorkOS provider (OAuth + AuthKit MCP)
│   └── instance.ts       Instance configuration loading
├── workspace/            Multi-tenant workspace system
│   ├── workspace-store.ts  Workspace CRUD operations
│   ├── types.ts          Workspace, WorkspaceMember, WorkspaceRole
│   └── scaffold.ts       Workspace initialization helpers
├── bundles/              MCPB bundle lifecycle
│   ├── lifecycle.ts      Bundle install/uninstall/start/stop state machine
│   ├── manifest.ts       MCPB manifest validation (ajv, v0.3/v0.4)
│   ├── resolve.ts        Local bundle resolution
│   ├── types.ts          BundleRef, BundleManifest, BundleInstance
│   └── schemas/          Vendored MCPB JSON Schemas (v0.3, v0.4)
├── api/                  HTTP API (Hono framework)
│   ├── app.ts            Hono app factory, route registration
│   ├── server.ts         HTTP server startup
│   ├── auth-middleware.ts Auth middleware with workspace resolution
│   ├── handlers.ts       Route handler implementations
│   ├── events.ts         SSE event manager (broadcast, heartbeat)
│   ├── routes/           Modular route files (auth, chat, bootstrap, etc.)
│   └── middleware/        Hono middleware (CORS, etc.)
├── tools/                Tool definitions
│   ├── system-tools.ts   System tools factory (search, manage, delegate)
│   ├── delegate.ts       nb__delegate multi-agent tool
│   ├── registry.ts       ToolRegistry (aggregates MCP sources)
│   ├── workspace-mgmt-tools.ts  Workspace management tools
│   ├── user-tools.ts     User management tools
│   └── conversation-tools.ts   Conversation sharing tools
├── adapters/             Pluggable implementations
│   ├── structured-log-sink.ts   Per-conversation JSONL logs with cost
│   ├── workspace-log-sink.ts    Workspace-level daily JSONL logs
│   ├── console-events.ts        Stderr event logging
│   ├── callback-events.ts       Callback-based events (Ink UI)
│   ├── debug-events.ts          Verbose debug logging
│   └── noop-events.ts           Silent event sink
├── files/                File context extraction
│   └── types.ts          File config, supported formats (PDF, DOCX, etc.)
├── skills/               Skill discovery and matching
│   ├── loader.ts         File parsing (YAML frontmatter + markdown)
│   ├── matcher.ts        Two-phase matching (triggers → keywords)
│   ├── types.ts          Skill, SkillManifest, SkillMetadata
│   └── core/             Core skills (always injected, e.g. bootstrap.md)
├── conversation/         Message persistence
│   ├── event-sourced-store.ts  Event-sourced store (persists engine events)
│   ├── jsonl-store.ts    Append-only JSONL (one file per conversation)
│   ├── memory-store.ts   In-memory (ephemeral)
│   ├── window.ts         History windowing (sliceHistory)
│   └── types.ts          ConversationStore interface
├── prompt/               System prompt composition
│   └── compose.ts        Multi-layer: identity → core skills → apps → skill
├── model/                LLM provider management
│   ├── registry.ts       Provider registry (AI SDK createProviderRegistry)
│   └── stream.ts         doStream helper — calls model, emits text deltas
├── telemetry/            Anonymous product telemetry
│   ├── posthog-sink.ts   PostHog event mapping
│   └── manager.ts        TelemetryManager (opt-in/out, anonymous ID)
└── cli/                  Interactive + headless terminal interface
    ├── index.ts          Entry point (Commander program assembly)
    ├── config.ts         nimblebrain.json loading
    ├── commands/         One file per command group
    ├── dev.ts            nb dev dual-process supervisor
    ├── app.tsx           Ink (React) UI component
    └── markdown.tsx      Lightweight markdown renderer for Ink
```

## Deployment

### Docker Compose

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ALLOWED_ORIGINS=http://localhost:27246  # for cookie-based auth
docker compose up --build
# Platform: internal only (API), Web: localhost:27246 (UI)
```

- Runtime container: Bun + Python 3.13 + Node 22 + mpak
- Web container: Caddy serving the SPA, proxying `/v1/*` to the platform

See `Dockerfile`, `web/Dockerfile`, and `docker-compose.yml` for full config.

## Architecture Reference

This section contains detailed internal architecture documentation for contributors.

### Token Budget Behavior

When cumulative input tokens exceed `maxInputTokens`, the engine returns immediately with `stopReason: "token_budget"`. Tool calls from the current LLM response are dropped (not executed) to avoid running tools whose results can't be processed.

### Tiered Tool Surfacing

When total tools ≤30, all are surfaced directly. Above 30 with no skill matched, only `nb__*` tools are direct (rest via proxy). When a skill matches with `allowed-tools`, matching tools + system tools are direct. Configurable via `maxDirectTools` (default 30). Implementation in `src/runtime/tools.ts`.

### Internal System Tools (UI-only, hidden from LLM)

| Tool | What it does |
|------|-------------|
| `nb__list_apps` | List installed apps with status, tools, trust scores |
| `nb__get_config` | Get runtime configuration (providers, model, limits) |
| `nb__manage_identity` | Write or reset workspace agent identity override (admin only) |
| `nb__version` | Platform version info |
| `nb__workspace_info` | Workspace metadata, telemetry status |

### Bundle Lifecycle

`BundleLifecycleManager` (`src/bundles/lifecycle.ts`) tracks bundle states:

- **Install**: mpak download → read manifest → extract UI metadata from `_meta["ai.nimblebrain/host"]` → record trust score → spawn MCP server → register → atomic config write → emit event
- **Uninstall**: check protected → stop server → remove source → atomic config removal → emit event (data NOT deleted)
- **States**: starting → running → crashed → dead (+ stopped for manual stop)
- **Atomic writes**: config changes use write-temp-then-rename

### Multi-Agent Delegation

`nb__delegate` (`src/tools/delegate.ts`) spawns child `AgentEngine.run()` with scoped prompt and filtered tools. Named agent profiles configured in `nimblebrain.json` under `agents`. Child iteration budget capped at `min(child.max, parent.remaining - 1)`. Multiple delegations in the same turn run concurrently via `Promise.all()`.

### MCP Tasks Client

`src/engine/tasks.ts` detects `CreateTaskResult` from MCP tool calls. Polls `tasks/get` until terminal state (completed/failed/cancelled). Emits `tool.progress` events during polling. Cancels active tasks on engine abort.

### Conversation Storage

- **`InMemoryConversationStore`** — default for programmatic use
- **`JsonlConversationStore`** — default for CLI, files in `~/.nimblebrain/conversations/`. Line 1: `{ id, createdAt }` metadata. Lines 2+: `StoredMessage` objects.
- **`EventSourcedConversationStore`** — persists engine events as JSONL. Append-only after creation. Token totals, cost, and last model derived at read time from `llm.response` events via `deriveUsageMetrics()`. Supports multi-user conversations with ownership, visibility (private/shared), and participant management.

### Identity System

Pluggable authentication via `IdentityProvider` interface (`src/identity/provider.ts`). Configured via `instance.json` in the work directory:

- **`dev`** — No auth, default when no `instance.json` exists. All requests get a default identity.
- **`oidc`** — JWT verification via any OIDC provider. Auto-provisions users on first valid login.
- **`workos`** — Full OAuth code flow with PKCE, token refresh, managed users via WorkOS. Supports MCP OAuth for external client access via AuthKit.

Each request carries a `UserIdentity` (id, name, email, role) threaded through `AppContext` in Hono middleware.

### Workspace System

Multi-tenant workspace isolation (`src/workspace/`). Key types: `Workspace`, `WorkspaceMember`, `WorkspaceRole` (owner, admin, member).

Bundles can be installed per-workspace (tracked via `BundleInstance.wsId`). Each workspace gets its own `ToolRegistry` with unqualified tool names. `WorkspaceRuntime` handles per-workspace bundle spawning.

`createSystemTools()` takes `getRegistry: () => ToolRegistry` (callback) instead of a direct registry reference, enabling dynamic workspace-scoped registries. The runtime maintains a `_workspaceRegistries` map keyed by workspace ID.

**Workspace isolation in tool handlers:** All tool handlers that access data must use `runtime.requireWorkspaceId()` (throws if missing). Do not use `getCurrentWorkspaceId()` (nullable) or `getBundleInstances()` (unfiltered) in tool handlers. In dev mode, `requireWorkspaceId()` returns `"_dev"`.

### System Prompt Composition

`src/prompt/compose.ts` joins layers with `---`:
- Layer 0: Identity — context skills or default fallback
- Layer 1: Core skills — always present (bootstrap.md teaches meta-tool usage)
- Layer 2: Installed Apps — dynamically injected list with UI status and MTF trust scores
- Layer 3: Matched skill system prompt

### HTTP API Internals

**Authentication:** Bearer token via `Authorization` header or HttpOnly session cookie (`nb_session`). Cookie attributes: HttpOnly, SameSite=Lax, Secure in production. Bearer header takes precedence over cookie.

**CORS:** Dynamic. Dev mode: `Access-Control-Allow-Origin: *`. With auth: only `ALLOWED_ORIGINS` env var origins, with credentials support.

**MCP endpoint (`/mcp`):** Streamable HTTP for external MCP clients. 100 concurrent sessions (env: `MCP_MAX_SESSIONS`), 30-minute TTL (env: `MCP_SESSION_TTL_MS`). Disabled when `features.mcpServer` is `false`. When `authkitDomain` is configured, returns `WWW-Authenticate` header on 401 for automatic OAuth discovery by MCP clients. See [`docs/mcp-oauth.md`](docs/mcp-oauth.md) for setup instructions.

**MCP OAuth discovery endpoints:**
- `GET /.well-known/oauth-protected-resource` — RFC 9728 Protected Resource Metadata
- `GET /.well-known/oauth-authorization-server` — RFC 8414 Authorization Server Metadata (proxied from AuthKit)

### SSE Event Streams

**Workspace-level** (`GET /v1/events`): Events: `bundle.installed`, `bundle.uninstalled`, `bundle.crashed`, `bundle.recovered`, `bundle.dead`, `data.changed`, `config.changed`, `skill.created`, `skill.updated`, `skill.deleted`, `file.created`, `file.deleted`, `bridge.tool.call`, `bridge.tool.done`, `heartbeat` (30s).

**Per-conversation** (`GET /v1/conversations/:id/events`): For multi-participant chat. Security: `requireAuth` → `requireWorkspace` → `canAccess()`. Events: `user.message`, `text.delta`, `tool.start`, `tool.done`, `llm.done`, `done`, `heartbeat`. Sender excluded from own broadcast.

### Web Client Internals

- **Chat**: editorial conversation style (serif assistant, italic user), streaming via SSE, inline tool call display
- **MCP App Bridge**: sandboxed iframes, postMessage proxy for tool calls
- **Agent-UI sync**: `data.changed` events forwarded to iframes with 100ms debounce
- **Login**: `"__cookie__"` sentinel token indicates cookie-based auth (suppresses Authorization header)

### Sidebar Slot Convention

The sidebar is data-driven from the placement registry:

| Slot | Purpose | Example |
|------|---------|---------|
| `sidebar` (priority < 10) | Ungrouped core nav at top | Home (0), Conversations (1) |
| `sidebar` (priority >= 10) | Grouped under "general" label | — |
| `sidebar.<group>` | Named group | `sidebar.apps` → "Apps" |
| `sidebar.bottom` | Pinned to bottom zone | Settings |
| `main` | App routes (pages, not nav) | Third-party apps |

Placements with a `route` field get React Router routes in `App.tsx`. Routes from `sidebar` use `/app/<route>` (except Home → `/`).

### Configuration Reference

Config file: `nimblebrain.json`. Validated at startup against `src/config/nimblebrain-config.schema.json` (JSON Schema draft-07, AJV). Unknown keys warn, structural errors throw.

**Config resolution** (when no `--config` flag):
1. `--workdir <dir>` → `<dir>/nimblebrain.json`
2. Otherwise → `./nimblebrain.json` (CWD)

#### Bundle Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Bundle name from mpak registry |
| `path` | string | Local filesystem path (resolved relative to config file) |
| `env` | object | Environment variables passed to the bundle process |
| `allowedEnv` | string[] | Host env vars this bundle may access |
| `protected` | boolean | Prevents uninstall via `nb__manage_app` |
| `trustScore` | number\|null | MTF trust score (0-100) |
| `ui` | object\|null | UI metadata: `{ name, icon, primaryView? }` |

#### Feature Flags

All default to `true`. Setting to `false` removes the capability entirely — tool not registered, not visible to LLM, returns 403 via HTTP.

| Flag | Controls | Tool(s) Affected |
|------|----------|-----------------|
| `bundleManagement` | Install/uninstall/configure apps | `nb__manage_app` |
| `skillManagement` | Create/edit/delete skills | `nb__manage_skill` |
| `delegation` | Multi-agent delegation | `nb__delegate` |
| `toolDiscovery` | Tool search (scope=tools) | `nb__search` |
| `bundleDiscovery` | Registry search (scope=registry) | `nb__search` |
| `mcpServer` | External MCP access via `/mcp` | `/mcp` endpoint |
| `fileContext` | File upload and context extraction | File processing |
| `userManagement` | Create/delete users | `nb__manage_users` |
| `workspaceManagement` | Workspaces, members, sharing | `nb__manage_workspaces` |

**Enforcement:** Three layers — (1) tools excluded from registry at startup, (2) `POST /v1/tools/call` returns 403, (3) MCP ListTools filters and CallTool rejects. Read-only tools (`nb__status`) are never gated.

#### Bundle Env Isolation

Bundle processes receive a **filtered** host environment. Default allowlist: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TMPDIR`, `TZ`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `NODE_ENV`, `BUN_ENV`, `NB_WORK_DIR`, `UPJACK_ROOT`, `PYTHONPATH`, `VIRTUAL_ENV`, `NODE_PATH`. Hard deny (never passed): `NB_API_KEY`, `NB_INTERNAL_TOKEN`. Opt in via `allowedEnv` in bundle config.

#### Remote Bundle Security

- Protocol must be `https:` (SSRF protection)
- Private IP ranges rejected: `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, `::1`
- Cloud metadata hostnames rejected
- Embedded credentials rejected
- Dev exception: `"allowInsecureRemotes": true` allows `http://localhost`

#### Source Name Protection

1. **Reserved prefix** — `nb` cannot be used as a bundle source name
2. **No duplicate sources** — registry rejects duplicates; built-in bundles register first

### MCP App Bridge Invariants

These are non-negotiable patterns. Violating them causes production bugs:

- **`tools/call` must return `CallToolResult` as-is** — never unwrap or cherry-pick fields
- **No `data.changed` from tool proxy** — causes infinite loops (tool → SSE → iframe refresh → tool)
- **Tool errors → JSON-RPC errors** — `isError: true` must send error response, not result
- **Bridge `destroyed` flag** — React StrictMode double-mounts; guard listeners with `destroyed` boolean
- **Iframe DOM isolation** — never put React-managed children in same container as raw DOM iframes
- **SlotRenderer effect depends only on `placementKey`** — callbacks via refs, not dep array (prevents flickering)
- **Shell components must not consume `ChatContext`** — use `ChatConfigContext` (stable) to avoid re-renders during streaming
- **`"primary"` virtual path** — `GET /v1/apps/:name/resources/primary` resolves to `primaryView.resourceUri` from manifest
- **Spec methods only** — use ext-apps spec method names in bridge; NimbleBrain extensions use `synapse/` prefix
- **`ui/initialize` field names** — `hostInfo` (not `serverInfo`), `hostCapabilities` (not `capabilities`), `hostContext.theme` is string

### Conventions

- **Runtime:** Bun (not Node). Use `bun run`, `bun test`, `bunx`.
- **Module system:** ESM only. All imports use `.ts` extensions.
- **Linting:** Biome (not ESLint/Prettier).
- **Type checking:** `bunx tsc --noEmit`. Strict mode.
- **Testing:** Bun's built-in test runner. Use `createEchoModel()` and `StaticToolRouter` to avoid LLM calls.
- **Model types:** Vercel AI SDK V3 types from `@ai-sdk/provider`.
- **HTTP:** Hono. Typed context via `AppEnv`/`AuthEnv`.
- **No classes for data** — plain interfaces + factory functions.
- **Tool results:** `structuredContent` for typed data, `content` for human-readable summary.
- **Prompt security:** `sanitizeLineField()` and XML containment tags in `compose.ts` — do not remove without reviewing `test/unit/prompt-injection.test.ts`.

### Defaults

| Setting | Value |
|---------|-------|
| Model | `claude-sonnet-4-5-20250929` |
| Max iterations | 10 (hard cap: 25) |
| Max input tokens | 500,000 |
| Max output tokens | 16,384 |
| Max history messages | 40 |
| Default bundles | none (platform capabilities are built in) |
| Work directory | `~/.nimblebrain` |
| Conversation store (CLI) | JSONL in `~/.nimblebrain/conversations/` |
| Conversation store (programmatic) | In-memory |

### Dependencies

| Package | Purpose |
|---------|---------|
| `ai` | Vercel AI SDK core (provider registry, types) |
| `@ai-sdk/anthropic` | Anthropic provider (prompt caching, streaming) |
| `@ai-sdk/openai` | OpenAI provider |
| `@ai-sdk/google` | Google Gemini provider |
| `@modelcontextprotocol/sdk` | MCP client (stdio transport) |
| `ajv` + `ajv-formats` | JSON Schema validation for MCPB manifests |
| `gray-matter` | YAML frontmatter parsing for skill files |
| `ink` | React-based terminal UI |
| `posthog-node` | Anonymous product telemetry (server-side) |
| `posthog-js` | Anonymous product telemetry (web client) |
| `hono` | HTTP framework (routing, middleware, typed context) |

### Observability

- **`StructuredLogSink`** — Per-conversation JSONL logs with LLM/tool latency, cache tokens, cost. Disable with `logging.disabled: true`.
- **`WorkspaceLogSink`** — Workspace-level daily rolling JSONL logs. Only persists workspace events (bundle lifecycle, data/config changes, skill/file operations).
- **`ConsoleEventSink`** — Human-readable stderr for development.
- **`DebugEventSink`** — Verbose JSON dumps (`--debug`).
- **`CallbackEventSink`** — Bridges events into React state (Ink UI).
- **`PostHogEventSink`** — Anonymous telemetry. No PII. Opt-out: `telemetry.enabled: false`, `NB_TELEMETRY_DISABLED=1`, or `DO_NOT_TRACK=1`.

