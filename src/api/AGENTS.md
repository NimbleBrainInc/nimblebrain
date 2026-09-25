# HTTP API

Scope: the Hono app, `/mcp`, sessions, and REST routes (`src/api/`).

## API Surfaces — Three Audiences

The platform serves three audiences with three protocol surfaces. They are not tiers; they are distinct contracts for distinct callers, intentionally split.

| Audience | Surface | When |
|---|---|---|
| External MCP clients (Claude, Claude Code, Cursor, any RFC-conformant client) | `POST /mcp/<wsId>` (Streamable HTTP MCP) | Any caller speaking the MCP protocol from outside the platform. Stateful: server allocates `Mcp-Session-Id` bound to workspace + identity. |
| Iframe widgets (synapse apps in sandboxed `<iframe>`s) | postMessage → `bridge.ts` → MCP SDK Client → `/mcp/<active wsId>` | Sandboxed UI talking via the MCP App ext-apps protocol. The bridge is the only iframe path; it shares one `Mcp-Session-Id` per browser tab for the active workspace, and a switch closes it and opens one on the new path. |
| Platform's own web shell (first-party React UI: header, settings, chat) | `POST /v1/tools/call`, `POST /v1/resources/read`, `GET /v1/...` (REST) | Trusted same-origin code. Stateless per request: `X-Workspace-Id` header on each fetch; no session, no transport lifecycle. |

> **`/mcp/<wsId>` is walled to the workspace in its URL.** Bare `/mcp` is refused. See "`/mcp/<wsId>` is walled to the workspace in its URL" below, the wall itself in `src/orchestrator/AGENTS.md`, and ADR-0036.

**Quick decision rules for contributors:**

- Adding a new feature to a settings tab, the chat composer, or anywhere in `web/src/` outside `web/src/bridge/` → use the REST helpers in `web/src/api/client.ts`. Do not import the MCP bridge client.
- Adding a feature to a synapse app (lives in `synapse-apps/<name>/ui/`) → use `@nimblebrain/synapse`'s `callTool` / `callToolAsTask` / `readResource`. The SDK speaks postMessage; the bridge handles the rest.
- Adding a new `nb__*` built-in tool → register it in the engine; both REST and `/mcp` audiences pick it up automatically. Don't add a special endpoint.

**Prefer tool actions over new REST routes.** When the web shell needs a new server-side capability (read installed connectors, save an operator OAuth client, fetch the OAuth redirect URI, etc.), the default answer is a new **action on an existing platform tool** (e.g., `manage_connectors`, `manage_workspaces`) — not a new `/v1/...` Hono route. A tool action gets routing, auth gating, structured-error handling, and external MCP-client access for free. A new route reinvents all of that and adds surface area to maintain.

The exceptions are real but narrow: add a route only when the endpoint genuinely **can't be a tool call**. Concretely:

- Sets a session-bound cookie that future requests need to present (`/v1/mcp-auth/initiate` sets `nb_oauth_state`).
- Is itself the redirect target of an external flow (`/v1/mcp-auth/callback` is loaded by the vendor's browser, not by our client).
- Streams non-JSON bytes (multipart upload, SSE for the chat stream).
- Serves raw bytes the browser loads directly, where it cannot send headers (`GET /v1/files/:fileId` behind an `<img>`).

If none of those apply, write a tool action. A simple JSON read like "what's the OAuth redirect URI?" is a tool action, not a route.

**Why split**, not consolidate: the web shell and external MCP clients have different correctness requirements. The shell is trusted same-origin React with its own React lifecycle; making it speak MCP would force it into stateful session lifecycle (workspace-bound `Mcp-Session-Id`, reset on switch, etc.) for zero gain. Keeping it on stateless REST means workspace switching is a no-op on transport state — next fetch reads the new `X-Workspace-Id` and goes. The bridge needs MCP because external MCP clients also use `/mcp`, so iframes inherit a spec-aligned protocol surface for free.

`/v1/tools/call` and `/v1/resources/read` are NOT being deprecated. They are the platform's first-party API and stay alive indefinitely.

## `/mcp/<wsId>` is walled to the workspace in its URL

ADR-0036. Bare `/mcp` is refused (`404`, naming the URL shape) — never a default workspace, never an identity-only surface. `routes/mcp.ts` authenticates against the canonical resource URL (`mcpResourceUrl`, `src/api/mcp-resource.ts`, built from `publicOrigin()` — never from `Host`/`X-Forwarded-*`), then checks membership of `<wsId>` on every request; a non-member, an unknown workspace and a malformed id all get the same `404 Workspace not found`. The session is bound to (identity, workspace) — `McpServerHost.ownsTransport` refuses a session id presented at another workspace's URL exactly like an unknown one, and the registry's `unavailable` is shown only to the bound caller. `tools/list` returns that workspace's tools (bare) + identity tools; `resources/list`/`read` reach identity resources and that one workspace, never a sweep. Do NOT reintroduce a per-request workspace header on this path, and do NOT build the resource URL from the request.

**Which credentials reach `/mcp/<wsId>`** — the provider verifies the signature and reports a `TokenGrant` on `VerifiedIdentity` (`src/identity/provider.ts`); `grantAdmits` (`src/api/auth-middleware.ts`) applies the rule above every provider. Never branch on a provider name in `/mcp` code.

| Credential | Recognised by | At `/mcp/<wsId>` |
|---|---|---|
| MCP authorization-server token | `grant.kind === "resource"` (WorkOS: issuer is AuthKit) | `aud` contains `mcpResourceUrl(wsId)` exactly, then membership. Refused on `/v1/*`. |
| Web app login (WorkOS User Management, OIDC, dev) | `grant.kind === "first_party"` | membership |
| Internal connector-to-host token | `validateInternalToken` | `403` — allowed only on `/v1/chat*` |

## MCP Session Architecture

Two-layer state model for `/mcp`. Don't merge them.

- **Transport map** (`McpServerHost.transports`): per-process LRU `Map<sessionId, TransportEntry>`. Owns the live `WebStandardStreamableHTTPServerTransport`, the SDK `Server` instance, in-flight JSON-RPC state, and `lastAccessedAt`. Process-bound — never serialize, never share across processes.
- **`SessionRegistry`** (`src/api/session-store/`): pluggable cluster-shared metadata. Stores `{sessionId, identityId, workspaceId, createdAt, lastAccessedAt}` only; `workspaceId` is half the binding a session-miss answer compares before saying `unavailable`. **No pod / instance / owner fields** — adding any would leak deployment vocabulary into a metadata interface. Implementations: `InMemorySessionRegistry` (default) and `RedisSessionRegistry`.

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
3. `sessionStore.type: "redis"`. Each tenant gets its own Redis instance in its own namespace. Default `nb:mcp:session:` keyPrefix is correct under that model.
4. `platform.strategy.type: RollingUpdate`. Only after (1).
5. `ConnectionRevalidator` (see `src/connectors/runtime/AGENTS.md`) gated to a single owner. The connection credential re-validation loop (`src/connectors/runtime/connection-revalidator.ts`) polls per-pod in-memory connection state; at `replicas > 1` every pod would poll the same provider account (N× the SaaS API calls against one shared key) and split-brain its flips (pod A flips to `reauth_required` and emits SSE on its own RunBus; pod B still shows `running`). It needs leader election (per-tenant Redis lease) so exactly one owner polls, and the same clustered RunBus as the limitation below to fan the flip out cross-pod. Until then it is single-owner-only — correct at `replicas: 1`, must be coordinated above it.

**Known limitation under `replicas > 1`: RunBus is single-process.** Chat turn replay/resume (the SSE-stream-backed viewer attaches to a per-conversation event log) lives in-memory on the pod that started the turn. A viewer landing on a different pod sees `isActive:false` for an in-flight turn elsewhere and the live frames don't fan out cross-pod. Sticky routing on `Mcp-Session-Id` (prereq #2) mitigates for the active tab; a pod restart or any cross-pod viewer (other tab/device) still drops resume mid-turn. The clustered Redis-backed RunBus is deferred work, tracked in `src/runtime/run-bus.ts` — `serve` warns at boot when `sessionStore.type === "redis"` so the gap is visible. `ConnectionRevalidator` (prereq #5) shares this constraint and the same deferred clustered-RunBus dependency: its `connection.state_changed` flips fan out only on the originating pod's RunBus today.

**Correctly per-pod (NOT a single-owner case): source self-heal.** `ConnectorLifecycleManager.tryRecoverSource` (hot-path re-registration of a workspace source that is installed but missing from the registry — torn down without a re-add, or never started because its endpoint was unreachable at boot; reached from the orchestrator's tool door and the three REST doors in `src/api/handlers.ts`) and its `recoveryAttempts` negative-cache cooldown are intentionally per-pod in-memory, and that is correct under `replicas > 1`. It guards a per-pod resource — `registriesByWs` is process-local and its sources are process-bound transports — so each pod must heal its own registry on its own miss. Unlike `ConnectionRevalidator`, it is reactive and idempotent (`hasSource` short-circuit, re-uses persisted OAuth state), touches no shared upstream account, and fans out to nobody, so it needs no leader election. Do NOT move the cooldown to Redis: a cluster-shared stamp would let one pod's failed heal suppress another pod's legitimate independent miss.

**TTL units: seconds at the surface, ms internally.** Operator-facing: `MCP_SESSION_TTL_SECONDS` env (highest priority) > `sessionStore.ttlSeconds` config > 8h default. Conversion to ms happens in `Runtime.getSessionStoreTtlMs()` only — registry constructors and the host's idle sweep both take ms from there. Don't add mixed-unit code elsewhere.

## Client address

**`clientAddressFor`** (`src/api/client-address.ts`) is the runtime's only
load-bearing `X-Forwarded-For` reader — right-most back `NB_TRUSTED_PROXY_HOPS`
(default 1), never left-most. The two other readers (`auth-middleware.ts`,
`mcp-server.ts`) feed log lines and decide nothing; do not add a third that does.
