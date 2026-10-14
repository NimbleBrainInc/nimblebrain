# Tools

Scope: tool sources, the MCP client (`mcp-source.ts`), and the credential store (`src/tools/`). Tool-name parsing and the workspace wall are in `src/orchestrator/AGENTS.md`.

**An update tool here is a patch: an omitted field is left alone, and `null` clears.** The rule and the schema form are in `src/platform/AGENTS.md` §1.3; `set_model_config` in `core-source.ts` is the reference.

## Credentials

**Every secret goes through one door.** `CredentialStore` (`src/tools/credential-store.ts`) is scoped — `instance` (`{workDir}/credentials/secrets/`), `workspace` (`workspaces/<wsId>/credentials/secrets/`), `user` (`users/<userId>/credentials/secrets/`) — and it is built only by `createCredentialStore` (`src/tools/credential-store-backend.ts`), which reads the `secrets` config block — at the composition root, where the audit sink is attached and `runtime.getCredentialStore()` hands it out, and in the operator `secrets` subcommand, which has no runtime. `Runtime.start` installs that instance via `setCredentialStore` for the leaf readers (`remote-transport.ts`, `oauth-static-client.ts`) that hold no runtime; reach it with `requireCredentialStore()` there and with the runtime accessor everywhere else. **Never construct a `FileCredentialStore`** — a direct construction bypasses the configured backend, so on a deployment that seals it reads and writes plaintext. A value that claims to be sealed opens on `reveal()` or throws, never on `get` (a `get` without a reveal is the presence probe) and never as plaintext; see ADR-0035.

Config **references** a secret and never carries one: `{ ref: "credential", key }` (`src/tools/credential-ref.ts`) is accepted on `transport.auth.token` / `.value`, every `transport.headers` value, `oauthClient.clientSecret`, and — resolved at boot by `resolveInstanceCredentialRefs`, anywhere in `nimblebrain.json` / `instance.json` — the provider, broker, gateway and IdP keys. Workspace references on `transport.auth` and `transport.headers` resolve **on every request**, so rotating one is a `put` on the same key; `oauthClient.clientSecret` is read when the connection starts or an authorization begins. There is no `${VAR}` expansion in a transport config.

A read is attributable: `get(scope, key, { caller, purpose })` returns a `Redacted` that emits `audit.credential_read` **on `reveal()`** — so a presence probe costs no log line and a use always writes one, once per read. Never emit that event from anywhere but the store.

**An OAuth connection's records are secrets, and go through the same door.** `WorkspaceOAuthProvider` owns the OAuth state machine; it owns no file format. Its records per `(owner, server)` — `tokens`, `verifier`, `client` (the DCR registration, carrying a `client_secret` for a confidential client), `identity` (OIDC claims), and the `auth_lost` flag (the credential was rejected and nobody has reconnected or disconnected since; it outlives the tokens the SDK deletes on `invalid_grant`, so the boot seed can still tell `reauth_required` from `not_authenticated`) — are keys in the credential store at the connection's scope: `mcp-oauth.<serverName>.<record>`, JSON strings the store holds opaquely (`src/tools/mcp-oauth-records.ts`). Connection-state derivation and the boot probe read presence through the same keys (`hasMcpOAuthTokens`), never the filesystem; revocation, disconnect and uninstall delete keys (`McpOAuthRecords.deleteAll`), never a directory.

**Credentials live with their owner — the workspace for shared connectors, the identity for personal ones.** Workspace-shared connector credentials are reachable at `{workDir}/workspaces/<wsId>/credentials/...`, constructed only through `WorkspaceContext` (via `runtime.getWorkspaceContext(wsId)`) or `FileCredentialStore`. A **personal connector** (a user's own remote MCP connection, reachable across their workspaces) is instead **identity-owned**: its OAuth records live at `user` credential scope via the `WorkspaceOAuthProvider` `{type:"user"}` arm — outside any workspace, so leaving a workspace never orphans them. Ownership is **structural** (the credential's scope), not a field: identity connectors do NOT set `oauthScope`, and a **ConnectorRef**'s `oauthScope` admits only `"workspace"`. Otherwise `users/<userId>/...` holds non-credential per-user data (`users/<userId>/skills/`, the personal-connector install record `users/<userId>/connectors.json`). Hand-building `join(workDir, "users", userId, "credentials", ...)` is a regression caught by `check:credential-paths`.

## Long-Running Tools (MCP Tasks)

Any MCP tool whose work exceeds the stock MCP request timeout (~60 s) must run as a **task**. Task augmentation is the `2026-07-28` tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) and nothing else (ADR-0046): the 2025-11-25 tasks utility (`params.task`, `CreateTaskResult`, `tasks/result`) is never sent. The retry policy is ADR-0029's.

**The runtime drives the task wire itself** (`src/tools/mcp-task-client.ts`), on the connection's own transport: SDK v2 has no client for the extension (typescript-sdk#2189). Keep every task call behind the `TaskClient` seam so the wire can be replaced by the SDK's client when it ships, and never claim the tasks extension on the connection's capabilities: the SDK cannot read a task result, so the claim goes on the task wire's own requests only.

### Authoring a long-running tool

Serve it over `2026-07-28` and advertise the tasks extension; a 2025-era connection never carries a task. FastMCP (Python) implements tasks only as this extension and negotiates it on `2026-07-28` connections:

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

- `mode="optional"` (or `task=True`) runs as a task for a client that opts in and inline otherwise. Use this: a 2025-era client still reaches the tool.
- `mode="required"` refuses a client that does not opt in. On a 2025-era connection the runtime refuses such a tool before dispatch, so it is uncallable there.
- `mode="forbidden"` (the default) never runs as a task. Use for fast tools.

### What the engine does

1. **2026-07-28, server advertises the extension:** every call takes the task path, one made for a `/mcp` client included (its `ToolExecuteOptions.caller` applies only on the inline path). The `tools/call` names the extension in its own `_meta` client capabilities; the server decides per call and may answer outright (accepted as a synthetic `nb-inline-*` task, already completed). (`src/tools/mcp-source.ts::execute`, `mcp-task-client.ts`)
2. **2025-era connection:** no task is ever attached and no `tasks` capability is claimed. A tool with `execution.taskSupport: "optional"` is called inline. One with `"required"` is refused before dispatch with an `isError` result naming the reason (`McpSource.taskRequiredRefusal`), never sent to fail at the server. `startToolAsTask` (the `/mcp` endpoint's entry) applies the same refusal and runs any other call inline through `inlineTaskClient`, reported as an already-completed task. A connection also lands here when the server answers the `server/discover` probe with a 500 (`connectOrFallBackToLegacy`). That falls back at once, without retrying the probe: a strict 2025 server answers 500 every time, a gateway's 502–504 does not fall back, and every reconnect probes again.
3. Polls the task (`tasks/get`, which inlines the outcome) — `taskCreated` → `taskStatus`* → terminal `result | error` — and emits a `tool.task_status` event on every `taskStatus`. A task that asks for input (`input_required`) is cancelled and reported: the runtime has no one to ask.
4. Run-scoped `AbortSignal` is threaded through `ToolRouter.execute(call, signal)` → `ToolSource.execute(..., signal)` → the task stream. An abort sends `tasks/cancel`. A `tasks/cancel` that fails is logged at warn with the source and task id, because the remote job may still be running; it never fails the caller, which is already tearing down.
5. Inline calls use the regular `client.callTool(...)` path and the same signal.
6. Retry (ADR-0029): **inline calls** re-establish the connection and retry once on transport error. **Task calls never retry** — task state lives server-side, so a retry would duplicate the work. Every call to a server advertising the extension takes the task path, so none of that server's calls is retried, and each keeps a task handle until the sweeper's grace window ends.

A task call does not hold the request open for the work: `tools/call` returns a task in milliseconds and the task wire polls it.

### Dual-channel contract (engine + entity)

The task channel is how the **agent** awaits the result. Apps that have UIs should also update a **persistent entity** on each phase transition (via the connector's state store, typically Upjack). This gives the UI a live view that survives:
- The LLM losing interest mid-run
- The client disconnecting
- The agent process being bounced

Both channels are sources of truth for different consumers. They must be kept in lockstep by the worker:

```
ctx.report_progress(...)  ─► task status (tasks/get)      ─► engine ─► chat UI
app.update_entity(...)    ─► resources/list_changed       ─► relay  ─► Synapse UI (useDataSync)
```

### Startup reaper

Long-running entities are orphaned if the connector process dies mid-run. On startup, the server sweeps every entity still marked `working` to `failed`, with a reason saying the run was interrupted, so the UI never shows a run that will not finish.
