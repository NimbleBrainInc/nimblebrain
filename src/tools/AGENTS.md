# Tools

Scope: tool sources, the MCP client (`mcp-source.ts`), and the credential store (`src/tools/`). Tool-name parsing and the workspace wall are in `src/orchestrator/AGENTS.md`.

## Credentials

**Every secret goes through one door.** `CredentialStore` (`src/tools/credential-store.ts`) is scoped — `instance` (`{workDir}/credentials/secrets/`), `workspace` (`workspaces/<wsId>/credentials/secrets/`), `user` (`users/<userId>/credentials/secrets/`) — and it is built only by `createCredentialStore` (`src/tools/credential-store-backend.ts`), which reads the `secrets` config block — at the composition root, where the audit sink is attached and `runtime.getCredentialStore()` hands it out, and in the operator `secrets` subcommand, which has no runtime. `Runtime.start` installs that instance via `setCredentialStore` for the leaf readers (`remote-transport.ts`, `oauth-static-client.ts`) that hold no runtime; reach it with `requireCredentialStore()` there and with the runtime accessor everywhere else. **Never construct a `FileCredentialStore`** — a direct construction bypasses the configured backend, so on a deployment that seals it reads and writes plaintext. A value that claims to be sealed opens on `reveal()` or throws, never on `get` (a `get` without a reveal is the presence probe) and never as plaintext; see ADR-0035.

Config **references** a secret and never carries one: `{ ref: "credential", key }` (`src/tools/credential-ref.ts`) is accepted on `transport.auth.token` / `.value`, every `transport.headers` value, `oauthClient.clientSecret`, and — resolved at boot by `resolveInstanceCredentialRefs`, anywhere in `nimblebrain.json` / `instance.json` — the provider, broker, gateway and IdP keys. Workspace references on `transport.auth` and `transport.headers` resolve **on every request**, so rotating one is a `put` on the same key; `oauthClient.clientSecret` is read when the connection starts or an authorization begins. There is no `${VAR}` expansion in a transport config; the one remaining env-template expander is `redis.url` in `src/api/session-store/factory.ts`, a different mechanism.

A read is attributable: `get(scope, key, { caller, purpose })` returns a `Redacted` that emits `audit.credential_read` **on `reveal()`** — so a presence probe costs no log line and a use always writes one, once per read. Never emit that event from anywhere but the store.

**An OAuth connection's records are secrets, and go through the same door.** `WorkspaceOAuthProvider` owns the OAuth state machine; it owns no file format. Its four records per `(owner, server)` — `tokens`, `verifier`, `client` (the DCR registration, carrying a `client_secret` for a confidential client), `identity` (OIDC claims) — are keys in the credential store at the connection's scope: `mcp-oauth.<serverName>.<record>`, JSON strings the store holds opaquely (`src/tools/mcp-oauth-records.ts`). Connection-state derivation and the boot probe read presence through the same keys (`hasMcpOAuthTokens`), never the filesystem; revocation, disconnect and uninstall delete keys (`McpOAuthRecords.deleteAll`), never a directory. A pre-store `credentials/mcp-oauth/<server>/*.json` file goes on that record's first touch — imported by a read, superseded by a write — so there is no script and no maintenance window; `legacyMcpOAuthDir` is the only site that still names that directory, and it goes when no deployment can still be carrying one.

**Credentials live with their owner — the workspace for shared connectors, the identity for personal ones.** Workspace-shared connector credentials are reachable at `{workDir}/workspaces/<wsId>/credentials/...`, constructed only through `WorkspaceContext` (via `runtime.getWorkspaceContext(wsId)`) or `FileCredentialStore`. A **personal connector** (a user's own remote MCP connection, reachable across their workspaces) is instead **identity-owned**: its OAuth records live at `user` credential scope via the `WorkspaceOAuthProvider` `{type:"user"}` arm — outside any workspace, so leaving a workspace never orphans them. Ownership is **structural** (the credential's scope), not a field: identity connectors do NOT set `oauthScope`. The legacy `oauthScope: "user"` on a **ConnectorRef** (the legacy member-scoped-in-a-workspace-registry model) stays deleted from the read path — the loader `src/connectors/runtime/lifecycle.ts::assertConnectorRefIsPostStage2` throws `LegacyOAuthScopeError` on any disk record carrying it. The guard stays as a permanent floor; the one-shot migration that produced clean data is retired. Otherwise `users/<userId>/...` holds non-credential per-user data (`users/<userId>/skills/`, the personal-connector install record `users/<userId>/connectors.json`). Hand-building `join(workDir, "users", userId, "credentials", ...)` is a regression caught by `check:credential-paths` — **except** `users/<userId>/credentials/mcp-oauth/`, the legacy import root above, which the lint allows and which only `legacyMcpOAuthDir` builds.

## Long-Running Tools (MCP Tasks)

Any MCP tool whose work exceeds the stock MCP request timeout (~60 s) must be written as a **task-augmented tool**. The engine implements the client side of the MCP draft 2025-11-25 `tasks` utility end-to-end; connector authors only have to opt in.

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

The task channel is how the **agent** awaits the result. Apps that have UIs should also update a **persistent entity** on each phase transition (via the connector's state store, typically Upjack). This gives the UI a live view that survives:
- The LLM losing interest mid-run
- The client disconnecting
- The agent process being bounced

Both channels are sources of truth for different consumers. They must be kept in lockstep by the worker:

```
ctx.report_progress(...)  ─► notifications/tasks/status  ─► engine ─► chat UI
app.update_entity(...)    ─► resources/list_changed       ─► relay  ─► Synapse UI (useDataSync)
```

### Startup reaper pattern

Long-running entities can get orphaned if the connector subprocess dies mid-run. The canonical fix is a startup sweep that marks any entity stuck in `working` as `failed` with a clear reason. See `synapse-apps/synapse-research/src/mcp_research/server.py::_reap_orphaned_runs()` for the reference implementation.

### Reference server

`synapse-apps/synapse-research` is the first consumer of this pattern. Its `tests/test_spec_compliance.py` exercises every MUST from the spec against an in-process FastMCP client and is a good template for new task-aware connectors.
