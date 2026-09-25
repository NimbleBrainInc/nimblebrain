# NimbleBrain

> This file is read by agents. Keep edits terse, imperative, token-aware. No long-form prose; bullets with concrete triggers and examples.

Self-hosted platform for MCP Apps and agent automations, built on Bun. Agentic loop + MCP connector management + interactive UI host + cron-scheduled automations + skill-driven prompt composition + HTTP API + web client.

> This file is the operating manual — *how to work here* (build, conventions, gotchas).
> The domain model — *what the nouns mean and the invariants* — lives in
> [`CONTEXT.md`](./CONTEXT.md); architectural decisions — *why it's this way* — live in
> [`adr/`](./adr). Domain facts belong in `CONTEXT.md`; reference them from here rather
> than restating them.

This file holds what applies to every change. A rule tied to specific code lives in an `AGENTS.md` beside that code — see [Guides](#guides).

## Build & Verify

```bash
bun install                # Install dependencies
bun run dev                # API (:27247) + Web (:27246) with watch/HMR
bun run dev:worktree       # Run from any worktree against an isolated workdir on alt ports — see "Worktree dev" below
bun run dev:api            # API only with auto-restart
bun run verify             # Full CI parity — runs every subscript below
bun run verify:static      # format:check + lint + check + check:cycles
bun run verify:test-unit   # test:unit + test:web + test:platform-apps

bun run test               # Unit then integration (stops at the first failing suite)
bun run test:unit          # Unit tests only (fast, ~10s)
bun run test:integration   # Integration tests only
bun run lint               # Biome linter
bun run format:check       # Biome format diff (no writes) — matches CI
bun run check              # TypeScript strict mode
bun run format             # Biome auto-format (writes)

cd web && bun install      # Web client dependencies (separate package.json)
cd web && bun run build    # Web production build → web/dist/

bun run install:platform-apps    # Platform app UI deps (each a separate package.json) — the exact command CI runs
bun run build:platform-apps      # Rebuild every src/platform/*/ui (vite single-file)
```

- **Before opening a PR, run `bun run verify`.** It mirrors CI by construction: `.github/workflows/ci.yml` invokes only `verify:*` subscripts (plus `test:integration`). To add or change a check, edit the matching subscript in `package.json`. If CI catches something `verify` didn't, fix the subscript, not a checklist.
- **A fresh checkout/worktree must install `web/` AND every `src/platform/*/ui/` before `bun run verify`**, because `verify:test-unit` runs those separate packages and root `bun install` does not cover them (the symptom is a missing-module error such as `Cannot find package 'dompurify'`).
- **`test:unit` runs on root deps alone**, and the backend unit suite imports the shared bridge protocol (`web/src/bridge/*`). So a web-only *value* import must never leak into that graph: keep such deps type-only and inject the value at the browser entry (`web/src/sentry.ts` is the pattern). The `Unit Tests (root deps only)` CI job enforces this.
- **The dev launchers prepare a fresh checkout.** `dev`, `dev:empty`, `dev:minimal`, `dev:docs-demo`, and `dev:worktree` install `web/` dependencies and build any platform app UI missing its `dist/index.html`; `dev:worktree` also installs root dependencies, since `scripts/dev.ts` imports from `src/`. Only what is absent is done.
- **`bun run dev` does NOT rebuild the platform app UIs.** The API serves each app from its pre-built `src/platform/<name>/ui/dist/index.html`, read on iframe mount, not watched. After editing anything under `src/platform/*/ui/src/`, run `bun run build:platform-apps` and restart the dev server, or the iframe runs stale code.

### Worktree dev

`bun run dev:worktree` runs the platform from any git worktree against a worktree-local workdir, on alt ports, with no auth gate, so a feature branch can be QA'd without disturbing `~/.nimblebrain` or another worktree.

| Setting | Value |
|---|---|
| Workdir | `<worktree>/.nimblebrain-worktree/` (auto-seeded; gitignored) |
| Config | `<worktree>/.nimblebrain-worktree/nimblebrain.json` (auto-seeded on first run) |
| API / Web ports | 27271 / 27270 (override via `NB_API_PORT` / `NB_WEB_PORT`) |
| Auth | none (dev mode — no `instance.json`) |
| LLM keys | `ANTHROPIC_API_KEY` (and friends) read from your shell environment |

Reset with `rm -rf .nimblebrain-worktree && bun run dev:worktree`. Share state across worktrees with `NB_WORK_DIR=/abs/path bun run dev:worktree`. Suitable for Chrome DevTools-driven E2E tests against `/v1/*` (no login).

## Guides

Nested `AGENTS.md` files (each with a `CLAUDE.md` symlink) hold the rules for one area. Read the one for the code you are changing.

| Guide | Covers |
|---|---|
| [`src/platform/AGENTS.md`](./src/platform/AGENTS.md) | Authoring platform apps and their tools: MCP-native sources, strict input schemas, named output types, `ui://` MIME type |
| [`src/platform/automations/AGENTS.md`](./src/platform/automations/AGENTS.md) | Automation storage, per-run membership gate, run results |
| [`src/workspace/AGENTS.md`](./src/workspace/AGENTS.md) | Workspace roots and `assertWorkspaceRootExists`, write authorization, opaque ids, personal-workspace invariants |
| [`src/orchestrator/AGENTS.md`](./src/orchestrator/AGENTS.md) | The workspace wall: tool-name shape as scope, `routeToolCall`, name parsing, skill walling |
| [`src/tools/AGENTS.md`](./src/tools/AGENTS.md) | `CredentialStore`, credential refs, OAuth records, credential ownership; long-running (task-augmented) MCP tools |
| [`src/conversation/AGENTS.md`](./src/conversation/AGENTS.md) | Conversation paths, workspace binding on resume, no cross-workspace listing |
| [`src/files/AGENTS.md`](./src/files/AGENTS.md) | File store paths, bare `files://` URIs, the file locator |
| [`src/api/AGENTS.md`](./src/api/AGENTS.md) | Three API audiences, tool actions over new routes, `/mcp/<wsId>` wall and which credentials reach it, MCP sessions, `replicas > 1` prerequisites, `clientAddressFor` |
| [`src/hooks/AGENTS.md`](./src/hooks/AGENTS.md) | The inbound webhook door: never parse a body, uniform 404, delivery ids, rotation, provisioning |
| [`src/lifecycle/AGENTS.md`](./src/lifecycle/AGENTS.md) | Connector `on_ready` / `on_removing` notifications |
| [`src/connectors/runtime/AGENTS.md`](./src/connectors/runtime/AGENTS.md) | Connector teardown and workspace delete; connection credential re-validation |
| [`src/observability/AGENTS.md`](./src/observability/AGENTS.md) | `NB_DEBUG` / `nb_debug` namespaces, structured logs, OTel spans, what may be stamped |
| [`web/AGENTS.md`](./web/AGENTS.md) | Web shell: gating workspace writes, shell rules, chat panel workspace scope, main-area views |
| [`web/src/bridge/AGENTS.md`](./web/src/bridge/AGENTS.md) | MCP App Bridge rules: iframe scoping, handshake gate, notification relay, host capabilities |

## Conventions

- **Runtime:** Bun (not Node). Use `bun run`, `bun test`, `bunx`.
- **Lockfiles are frozen everywhere except local dev.** CI, both Dockerfiles, and `install:platform-apps` pass `--frozen-lockfile` — bun does not do this on its own in CI, and without it CI tests a freshly-resolved tree while the image ships the locked one. A frozen install that fails means a `package.json` moved without its `bun.lock`: run `bun install` in that package dir and commit the lockfile. `bun run dev` and `build:platform-apps` stay unfrozen so adding a dependency locally still works.
- **Module system:** ESM only. All imports use `.ts` extensions.
- **Linting:** Biome (not ESLint/Prettier). Run `bun run lint`.
- **Type checking:** `bunx tsc --noEmit`. Strict mode enabled.
- **Prefer typed-safe paths over `as unknown as T`.** When TS errors, find the input/output type matching runtime shape (e.g. stream-side vs prompt-side) before widening. Cast escape hatches require a comment naming the mismatch. Example: `src/model/inbound-fit.ts`.
- **Code-style rules beyond Biome/tsc live in [CODE_STYLE.md](./CODE_STYLE.md)** and are enforced by `bun run check:code-style` (part of `verify:static`). Add a rule when you find yourself enforcing the same pattern in review twice. Each rule lands with its check and the cleanup of existing violations in the same PR — otherwise it has no teeth.
- **HTTP framework:** Hono for routing and middleware. Typed context via `AppEnv`/`AuthEnv`.
- **Model types:** Use Vercel AI SDK V4 types (`LanguageModelV4`, `LanguageModelV4Message`, etc.) from `@ai-sdk/provider`. The engine calls `model.doStream()` directly. File parts carry `data` as the tagged `SharedV4FileData` union (`{ type: "data", data }` for inline bytes) — a bare `Uint8Array` type-errors, and provider converters silently drop a part whose `data.type` matches no arm.
- **No classes for data** — plain interfaces + factory functions preferred.
- **Tool results:** Return typed data in `structuredContent`, use `content` only for human-readable summary.
- **Errors:** Tool errors are caught per-call and returned as `isError: true` results. Engine errors surface via `run.error` event.
- **Logs:** use `log.*` from `src/observability/log.ts`, never raw `console.*` in operational code (it bypasses JSON/identity/correlation enrichment; `check:no-raw-console` enforces). Details in `src/observability/AGENTS.md`.
- **Documentation:** User- and operator-facing docs live in [`docs/`](./docs) (Astro + Starlight) and deploy to [docs.nimblebrain.ai](https://docs.nimblebrain.ai) via GitHub Pages. **Update them in the same PR as any user-facing change** (CLI, config, API, behavior), so they do not drift. `docs/` is a standalone package: `cd docs && bun install`, then `bun run dev` / `bun run build` (or `bun run docs:dev` / `docs:build` from the root). The docs build runs an internal-link check and is a required CI gate on any docs change (`.github/workflows/docs-ci.yml`). `docs/` is excluded from `bun run verify` (biome/tsc are scoped to `src/` and `web/`). `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `AGENTS.md`/`CLAUDE.md` remain the standard top-level OSS files.
- **Per-directory agent docs:** any `AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it (`ln -s AGENTS.md CLAUDE.md`). Edit `AGENTS.md`. New per-directory docs follow the same pattern. Don't invert it (real `CLAUDE.md` + symlinked `AGENTS.md`) — it confuses tools that prefer one or the other. A rule tied to one area's code goes in that folder's guide, not here, and gets a line in [Guides](#guides); this file loads in every session and Codex reads only the first 32 KiB of instructions.
- **CHANGELOG entries must be terse and scannable.** Target ~250–350 words per release (not per entry). Structure: short `### Highlights` with 3–5 one-sentence bullets, then `### Breaking` / `### Added` / `### Changed` / `### Fixed` / `### Removed`. One line per bullet; link to docs or the PR for depth instead of explaining implementation inline. Include migration-required operator actions (e.g. "run `scripts/migrate-tenant-files.ts`") in Fixed/Breaking. Cut internal refactors, release-pipeline polish, CI tweaks, and per-PR credit noise — they belong in `git log`, not the CHANGELOG. If a bullet needs more than one sentence to explain *what* changed and *why a reader cares*, either (a) link out or (b) rethink whether the reader needs this entry at all.

## Testing

Tests use `createEchoModel()` from `test/helpers/echo-model.ts` and `StaticToolRouter` to avoid LLM calls. No mocking of LLM providers needed.

| Tier | Directory | Command | What belongs here |
|------|-----------|---------|-------------------|
| Unit | `test/unit/` | `bun run test:unit` | Pure logic, mocked deps, no I/O or servers |
| Integration | `test/integration/` | `bun run test:integration` | `Runtime.start()`, HTTP servers, real crypto, subprocesses |
| Eval | `test/eval/` | `bun run eval` | LLM evals, require `ANTHROPIC_API_KEY` |

**Classification rule:** If a test calls `Runtime.start()`, `startServer()`, `Bun.serve()`, or `spawnSync()`, it belongs in `test/integration/`. Everything else goes in `test/unit/`.

Shared test helpers live in `test/helpers/` (imported by both unit and integration).

**Every bun process in the test path passes `--no-env-file`.** Bun auto-loads `.env`, so without it a developer's real keys (e.g. `COMPOSIO_API_KEY`) reach the test process, fail the tests that assert the unconfigured path, and let test code make live API calls. CI has no `.env`, so the failure looks local-only.

- The flag binds to one process and does not propagate: a child re-runs the auto-load itself. So it goes on the `test:*` scripts, on every `bun` a test spawns (`cli.test.ts` boots the full runtime; the `scripts/check-*` suites spawn the checkers), and on any single file you run by hand — `bun test --no-env-file <file>`.
- It disables dotenv, not the environment: a value exported in your shell outranks `.env` and survives regardless. `test:web` and `test:platform-apps` run in their own directories without the flag — neither reads a credential.
- A repo-wide `env = false` in `bunfig.toml` would make this deny-by-default and delete every flag site, but it also cuts `.env` from `bun run dev`, `start`, and `eval` unless each carries `--env-file=.env` — a separate change, tracked in #839.

## Project Structure

```
src/
├── engine/        Agentic loop (model → tool → repeat). Start here.
├── runtime/       High-level orchestration (Runtime.start → runtime.chat)
├── api/           HTTP API (Hono). Routes in api/routes/.
├── connectors/    Everything a connector is, split by the question each part answers:
│   ├── runtime/   a live connection's life — install/uninstall/start/stop, auth, probes
│   ├── catalog/   what can be installed — server detail, curated entries, schemas
│   ├── providers/ who brokers auth and session (providers/<vendor>/ behind the seam)
│   └── gateways/  hosted-MCP vendors that broker nothing and take one account key
├── platform/      The kernel's own apps — in-process MCP servers, one directory each (see platform/AGENTS.md)
├── tools/         System tool definitions (search, status, manage)
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
| `Runtime.startRun` (same file) | **The run-start door.** Every agent run is established here — membership gate, tool set, prompt, budget, sinks, engine — whatever woke it. `chat()` and `executeTask()` are thin adapters onto it |
| `src/runtime/run-spec.ts` | `RunSpec` / `RunHandle`: how a trigger describes a run to the door |
| `src/runtime/types.ts` | RuntimeConfig, ChatRequest, ChatResult |
| `src/connectors/runtime/lifecycle.ts` | Connector install/uninstall state machine |
| `src/platform/index.ts` | `createPlatformSources` — every platform app the kernel hosts |
| `src/api/app.ts` | HTTP routes and middleware |
| `src/tools/system-tools.ts` | System tools factory |
| `src/prompt/compose.ts` | System prompt assembly |

## Defaults

| Setting | Value |
|---------|-------|
| `models.default` | `anthropic:claude-sonnet-4-6` |
| `models.fast` | `anthropic:claude-haiku-4-5-20251001` |
| Max iterations | 25 (hard cap: 50) |
| Max input tokens | 500,000 |
| Max output tokens | 16,384 |
| Default connectors | none (platform capabilities are built in) |
| Work directory | `~/.nimblebrain` |
| API port | 27247 |
| Web port | 27246 |

## Workspace Isolation

The workspace is the tenancy boundary. These rules apply anywhere code touches workspace data; the detail is in the guides.

- **All tool handlers that access data must be workspace-scoped.** Use `runtime.requireWorkspaceId()` (never `getCurrentWorkspaceId()`). In dev mode it returns `"_dev"` — no special-case logic needed.
- **Hard-error on a missing `wsId`, don't silently default**, in any code path that touches workspace-scoped credentials or identity. A `?? "ws_default"` fallback would pool credentials across tenants. `startConnectorSource`'s named-connector and URL-connector (OAuth-provider) branches both throw; match them.
- **Every recursive mkdir on a workspace-scoped path passes `assertWorkspaceRootExists`** (via `ensureWorkspaceDir` or directly), and a `WorkspaceRootMissingError` is never fixed by creating the root, because only `WorkspaceStore.create` makes one. See `src/workspace/AGENTS.md`.
- **Every secret goes through `CredentialStore`**; never construct a `FileCredentialStore`, which bypasses the configured backend. See `src/tools/AGENTS.md`.
- **A session reaches exactly one workspace plus the caller's identity tools**, never a cross-workspace union, and a tool name's shape is its scope. See `src/orchestrator/AGENTS.md`.
- **Workspace-scoped writes have no org-admin bypass**, on the server or in the web tier. See `src/workspace/AGENTS.md` and `web/AGENTS.md`.

## API Surfaces

External MCP clients and iframe apps use `POST /mcp/<wsId>`; the first-party web shell uses REST (`web/src/api/client.ts`) and never imports the MCP bridge client outside `web/src/bridge/`. **A new server capability the shell needs is an action on an existing platform tool, not a new `/v1/...` route**, because a tool action gets routing, auth, structured errors, and MCP-client access for free. The narrow exceptions and the reasons for the split are in `src/api/AGENTS.md`.

## Prompt Security

`sanitizeLineField()` and XML containment tags in `compose.ts` are prompt injection mitigations. Do not remove without reviewing `test/unit/prompt-injection.test.ts`.

**Connector trust is an install decision, not a per-prompt one.** Do not add a numeric trust gate on any path that injects server-authored content into the prompt (skills, app guides, app state, custom instructions). Once a connector is active in the workspace its tools are already callable, so suppressing the workflow guidance that teaches the model how to use them safely makes the model less safe, not more — and tool descriptions, tool outputs, and `app://instructions` flow through ungated already. The defense is XML containment with `</tag>` escape in the body, the pattern used by `<app-state>`, `<app-guide>`, `<app-instructions>`, `<app-custom-instructions>`, and `<layer3-skill>`. Any new server-authored containment tag must escape its own closing form in the body the same way.

## Auto-Generated Files

Do not edit these manually:

- `bun.lock`, `web/bun.lock` — lock files, managed by `bun install`
- `web/dist/` — Vite build output, regenerated by `bun run build`
- `web/src/_generated/platform-schemas/` — TypeScript declarations derived from `src/platform/schemas/`. Regenerate with `bun run codegen` after editing any source schema. CI verifies via `bun run check:codegen` (part of `verify:static`); drift is a build failure.

## Published Schemas

`.github/workflows/schema-deploy.yml` publishes two hand-authored JSON Schemas to `schemas.nimblebrain.ai` on push to `main`. Editing either one ships it.

- `src/connectors/catalog/schemas/host-manifest.schema.json` → `/v1/nimblebrain-host.schema.json`: the `ai.nimblebrain/host` `_meta` extension, how an MCP server declares its UI placement in the host shell. It is **published-only** — nothing here validates against it, because the runtime reads that block from a catalog entry it already trusts. No local guard holds it in step with `HostManifestMeta` (`src/connectors/runtime/types.ts`), so change both together.
- `src/config/nimblebrain-config.schema.json` is the **canonical source** for the `nimblebrain.json` config schema — edit it here; the repo is upstream of the published artifact. The runtime validates against it at startup. It must stay in lockstep with the runtime feature surface in `src/config/features.ts`; `test/unit/config-schema-drift.test.ts` fails the build on drift.

## Releasing

See [RELEASING.md](./RELEASING.md) for the prescriptive release runbook. When the user asks to cut a release, follow that document literally — it covers tagging conventions (semver with `v` prefix, hyphen = pre-release), the step-by-step procedure, the verification checklist, and rollback. Releases are cut by pushing an annotated git tag matching `v*`; `.github/workflows/release.yml` does the rest. Do not bump `package.json` per release.

## Full Architecture

See `README.md` for complete architecture documentation, API reference, configuration, deployment, and CLI details.
