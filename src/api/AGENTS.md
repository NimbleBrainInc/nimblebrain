# HTTP API

Scope: the Hono app, `/mcp`, sessions, and REST routes (`src/api/`).

## API Surfaces — Three Audiences

The platform serves three audiences with three protocol surfaces. They are not tiers; they are distinct contracts for distinct callers, intentionally split.

| Audience | Surface | When |
|---|---|---|
| External MCP clients (Claude, Claude Code, Cursor, any RFC-conformant client) | `POST /mcp/<wsId>` (Streamable HTTP MCP) | Any caller speaking the MCP protocol from outside the platform. A 2025-era client is stateful: the server allocates `Mcp-Session-Id` bound to workspace + identity. A `2026-07-28` client is served per request, with no session. |
| Iframe widgets (synapse apps in sandboxed `<iframe>`s) | postMessage → `bridge.ts` → MCP SDK Client → `/mcp/<active wsId>` | Sandboxed UI talking via the MCP App ext-apps protocol. The bridge is the only iframe path; it shares one `Mcp-Session-Id` per browser tab for the active workspace, and a switch closes it and opens one on the new path. |
| Platform's own web shell (first-party React UI: header, settings, chat) | `POST /v1/workspaces/<wsId>/tools/call`, `…/resources/read`, `POST /v1/tools/call`, `GET /v1/...` (REST) | Trusted same-origin code. Stateless per request: the workspace is in each request's path, or the route names none; no session, no transport lifecycle. |

> **`/mcp/<wsId>` is walled to the workspace in its URL.** Bare `/mcp` is refused. See "`/mcp/<wsId>` is walled to the workspace in its URL" below, the wall itself in `src/orchestrator/AGENTS.md`, and ADR-0036.

**Quick decision rules for contributors:**

- Adding a new feature to a settings tab, the chat composer, or anywhere in `web/src/` outside `web/src/bridge/` → use the REST helpers in `web/src/api/client.ts`. Do not import the MCP bridge client.
- Adding a feature to a synapse app (lives in `synapse-apps/<name>/ui/`) → use `@nimblebrain/synapse`'s `callTool` / `callToolAsTask` / `readResource`. The SDK speaks postMessage; the bridge handles the rest.
- Adding a new `nb__*` built-in tool → register it in the engine; both REST and `/mcp` audiences pick it up automatically. Don't add a special endpoint.

**Prefer tool actions over new REST routes.** When the web shell needs a new server-side capability (read installed connectors, save an operator OAuth client, fetch the OAuth redirect URI, etc.), the default answer is a new **action on an existing platform tool** (e.g., `manage_connectors`, `manage_workspaces`) — not a new `/v1/...` Hono route. A tool action gets routing, auth gating, structured-error handling, and external MCP-client access for free. A new route reinvents all of that and adds surface area to maintain.

The exceptions are real but narrow: add a route only when the endpoint genuinely **can't be a tool call**. Concretely:

- Sets a session-bound cookie that future requests need to present (`/v1/workspaces/:wsId/mcp-auth/initiate` sets `nb_oauth_state`).
- Is itself the redirect target of an external flow (`/v1/mcp-auth/callback` is loaded by the vendor's browser, not by our client).
- Streams non-JSON bytes (multipart upload, SSE for the chat stream).
- Serves raw bytes the browser loads directly, where it cannot send headers (`GET /v1/files/:fileId` behind an `<img>`).

If none of those apply, write a tool action. A simple JSON read like "what's the OAuth redirect URI?" is a tool action, not a route.

**Why split**, not consolidate: the web shell and external MCP clients have different correctness requirements. The shell is trusted same-origin React with its own React lifecycle; making it speak MCP would force it into stateful session lifecycle (workspace-bound `Mcp-Session-Id`, reset on switch, etc.) for zero gain. Keeping it on stateless REST means workspace switching is a no-op on transport state — the next fetch builds its path from the new workspace and goes. The bridge needs MCP because external MCP clients also use `/mcp`, so iframes inherit a spec-aligned protocol surface for free.

`tools/call` and `resources/read` under `/v1/workspaces/<wsId>/` are NOT being deprecated. They are the platform's first-party API and stay alive indefinitely.

## `/mcp/<wsId>` is walled to the workspace in its URL

ADR-0036. Bare `/mcp` is refused (`404`, naming the URL shape) — never a default workspace, never an identity-only surface. `routes/mcp.ts` authenticates against the canonical resource URL (`mcpResourceUrl`, `src/api/mcp-resource.ts`, built from `publicOrigin()` — never from `Host`/`X-Forwarded-*`), then checks membership of `<wsId>` on every request (`isAddressedWorkspaceMember`, `src/api/workspace-address.ts`); a non-member, an unknown workspace and a malformed id all get the same `404 Workspace not found`. The session is bound to (identity, workspace) — `McpServerHost.ownsTransport` refuses a session id presented at another workspace's URL exactly like an unknown one, and the registry's `unavailable` is shown only to the bound caller. `tools/list` returns that workspace's tools (bare) + identity tools; `resources/list`/`read` reach identity resources and that one workspace, never a sweep. Do NOT reintroduce a per-request workspace header on this path, and do NOT build the resource URL from the request.

**Which credentials reach `/mcp/<wsId>`** — the provider verifies the signature and reports a `TokenGrant` on `VerifiedIdentity` (`src/identity/provider.ts`); `grantAdmits` (`src/api/auth-middleware.ts`) applies the rule above every provider. Never branch on a provider name in `/mcp` code.

| Credential | Recognised by | At `/mcp/<wsId>` |
|---|---|---|
| MCP authorization-server token | `grant.kind === "resource"` (WorkOS: issuer is AuthKit, `client_id` not in `firstPartyClientIds`) | `aud` contains `mcpResourceUrl(wsId)` exactly, then membership. Refused on `/v1/*`. |
| Web app login (WorkOS User Management, OIDC, dev), or an AuthKit token whose signed `client_id` is in `firstPartyClientIds` (ADR-0038) | `grant.kind === "first_party"` | membership |

These are the only credentials, on every route. There is no shared secret or service token: `authenticateRequest` admits a caller only through the identity provider, because a credential with no identity is a member of no workspace and so reaches nothing. The `dev` provider verifies every request as the local developer, so a dev request carries an identity like any other. The server authenticates with the runtime's provider and has none of its own (`startServer` takes no provider). A service that calls the runtime signs a user in and holds a first-party token (ADR-0038).

## REST names its workspace in the path

ADR-0037. A route is workspace-scoped (`/v1/workspaces/:wsId/…`, `WORKSPACE_ROUTE_PREFIX` + `requireWorkspace(ctx)` in `src/api/middleware/workspace.ts`, the same `isAddressedWorkspaceMember` check as `/mcp`) or identity-scoped (`/v1/…`, no workspace: bootstrap, `/v1/events`, a conversation or file located by its own id, and `POST /v1/tools/call`, which calls only a kernel tool that declares it works with no workspace, ADR-0043 and `src/tools/workspace-optional.ts`). There is no optional-workspace middleware and no fallback to a default workspace: a route that sometimes needs a workspace is two routes or a workspace-scoped one. `X-Workspace-Id` is read nowhere; it stays only in the inbound strip lists (`src/hooks/declaration.ts`), because a bundle might trust it. The web client builds each path with `workspacePath()` (`web/src/api/client.ts`) and throws `no_active_workspace` rather than send one without a workspace. Nothing in a body names a workspace either: a `ws_<id>-` qualified server, app or tool name is refused with `400` by `refuseQualifiedName` (`handlers.ts`), never routed or stripped, and a `conversationId` resolves only in the path's workspace (`src/conversation/AGENTS.md`).

## Response bodies are named types

Every JSON body a route sends is a type in `schemas/responses.ts`, sent with `json<T>()` from `types.ts`; errors go through `apiError`, whose body is `ApiErrorBody`. The web client and the tests import these names (the web shell through `web/src/_generated/api/`, emitted by `bun run codegen`), never a copy of their own. `responses.ts` imports nothing, so the emit carries no module graph into `web/`: a domain type a body carries is restated there and pinned to its source in `responses-drift-guard.ts`. Changing a body means changing its type, and every consumer that reads the moved field fails to compile. `check:rest-responses` enforces this (CODE_STYLE.md). Request bodies are validated at runtime against `schemas/rest.ts`.

SSE events follow the same rule. `schemas/events.ts` declares every frame each stream sends (`WorkspaceStreamEvents` for `/v1/events`, `ConversationStreamEvents` for `/v1/conversations/:id/events`), emitted to the web beside `responses.ts`. A frame the server builds itself (`subscribed`, `heartbeat`, and the turn's `user.message`, `done`, `cancelled`, `error`) is typed where it is built: `publishTurnEvent` and `broadcastToConversation` take a catalog key and its payload. A forwarded engine event is restated there and pinned to its `EngineEventPayloads` entry by `events-drift-guard.ts`, and the SSE route table can route only an event the workspace catalog declares. The guard checks every catalog entry that is not a server-built frame, so a new event on a stream is one entry in the catalog. Each catalog is also its stream's allowlist: `SSE_ROUTES` can route only a workspace catalog entry, and a run forwards to its viewers only the engine events `STREAMED_RUN_EVENTS` (`src/runtime/turn-stream.ts`) lists, a map keyed by the conversation catalog. List an event only when a client reads it; the rest stay on the server, `run.start`'s system prompt and connector skill bodies among them.

## Router middleware is chained per route

A router (`routes/*.ts`, a provider's `routes`) chains `requireAuth`, `errorLog` and any other middleware on each of its routes and never calls `.use()`. Every router is mounted at "/", and Hono turns a sub-app's `.use("*")` into a `/*` matcher on the parent, so it would run for every request the app handles: another router's routes and paths no router registered. Mount order in `app.ts` therefore decides nothing about auth. Only `app.ts` mounts app-wide middleware (tracing, metrics, CORS, security headers, the cross-site guard). `check:route-middleware` enforces this (CODE_STYLE.md), and `test/integration/route-middleware-scope.test.ts` walks the route table.

## Browser writes from another origin

A browser write (any method but `GET`/`HEAD`/`OPTIONS`) from another origin is refused on every route unless CORS allows that origin (`rejectCrossSiteWrites`, `src/api/middleware/fetch-site.ts`, mounted on `*` in `app.ts` beside CORS). The session cookie authenticates `requireAuth` routes and `/mcp/<wsId>`; a form or `text/plain` post needs no preflight, and `SameSite=Lax` does not stop one from another origin on the same site. Server callers (MCP clients, vendor webhooks, the channels service) send no `Sec-Fetch-Site` and pass. Do NOT mount it per path or exempt a route: a new route is covered by construction, and `test/integration/cross-site-writes.test.ts` fails if any non-safe route in the table admits a cross-site write.

## Two eras on one `/mcp/<wsId>`

**The two legs are equivalent, and both are maintained:** a client on either era can do the same things at the door. `McpServerHost.handlePost` routes on the SDK's own classifier, `isLegacyRequest`: a request carrying the `2026-07-28` `_meta` envelope goes to a per-request SDK v2 server (`createMcpHandler`, `legacy: "reject"`); everything else goes to the sessionful 2025 leg below, on SDK v1. Both legs mount one set of handlers (`createHandlers` in `mcp-server.ts`), so the wall, the tool names and the error shapes cannot drift, and `test/integration/mcp-era-parity.test.ts` runs the same scenarios against both. A capability added to one leg lands on the other in the same PR, with a scenario in that suite. The 2025 leg stays on SDK v1 because SDK v2 refuses to send a task-shaped `tools/call` result (its result validation requires `content` beside `task`), and the iframe bridge's `callToolAsTask` needs one. Do not add per-session state the modern leg would need: it has no session.

Tasks on the 2026 leg are the tasks extension (SEP-2663), served by the runtime's own code in `mcp-modern-tasks.ts` because SDK v2 neither produces a task result nor routes `tasks/*` (typescript-sdk#2189): `handleModern` answers `tasks/get` and `tasks/cancel` ahead of the SDK. The door keeps no task table. The id it hands out names the source beside the connector's task id, and the connector's owner check (workspace, identity, source) refuses everyone else, so a poll is answered on any request. The task itself lives in that pod's `McpSource`, like a 2025 session's transport: at `replicas > 1` a 2026 poll must reach the pod that started the task, and nothing routes it there yet (see "Running more than one replica" below).

## MCP Session Architecture

Two-layer state model for the 2025 leg of `/mcp`. Don't merge them.

- **Transport map** (`McpServerHost.transports`): per-process LRU `Map<sessionId, TransportEntry>`. Owns the live `WebStandardStreamableHTTPServerTransport`, the SDK `Server` instance, in-flight JSON-RPC state, and `lastAccessedAt`. Process-bound — never serialize, never share across processes.
- **`SessionRegistry`** (`src/api/session-store/`): pluggable cluster-shared metadata. Stores `{sessionId, identityId, workspaceId, createdAt, lastAccessedAt}` only; `workspaceId` is half the binding a session-miss answer compares before saying `unavailable`. **No pod / instance / owner fields** — adding any would leak deployment vocabulary into a metadata interface. Implementations: `InMemorySessionRegistry` (default) and `RedisSessionRegistry`.

Routing requests to the process owning a session's transport is the **load balancer's** job (ALB `lb_cookie` stickiness; see "Running more than one replica" for why hashing on `Mcp-Session-Id` cannot do it). The registry doesn't route; it can't move transports.

**Reclamation invariants** — see `mcp-server.ts` file header for the why:

- Idle TTL and LRU-on-capacity both go through `evict(sid, reason)`. **Delete from the map before calling `close()`**, never the reverse — concurrent-request race.
- Same TTL drives both layers (`Runtime.getSessionStoreTtlMs()` → host sweep + registry). One knob.
- Capacity overflow is never a 4xx. A well-formed initialize at `MAX_MCP_SESSIONS` evicts the LRU and is admitted. Do not reintroduce `Too many active sessions`.

**Session-miss `error.data.reason`** has exactly two values:

- `not_found` — registry has no entry (idle-TTL eviction or never created).
- `unavailable` — registry has an entry; this process doesn't have the transport. Don't try to distinguish process-restart from sticky-miss in the response — operators do that via deploy timing + `transport-count vs registry-size` divergence.

See "Running more than one replica" below.

**TTL units: seconds at the surface, ms internally.** Operator-facing: `MCP_SESSION_TTL_SECONDS` env (highest priority) > `sessionStore.ttlSeconds` config > 8h default. Conversion to ms happens in `Runtime.getSessionStoreTtlMs()` only — registry constructors and the host's idle sweep both take ms from there. Don't add mixed-unit code elsewhere.

## Running more than one replica

`replicas: 1` is the only supported topology. The runtime assumes it is the only process on a tenant's data: a second replica double-executes work, loses writes, and serves stale state. This list is what blocks it, grouped by the kind of fix; each group needs every item fixed, not some. **Sticky routing fixes almost none of it.** Only ALB `lb_cookie` affinity pins a caller to a pod, and it pins only browsers. Header-hash routing on `Mcp-Session-Id` cannot pin a session to the pod that created it: the id is a random UUID (`mcp-server.ts`), so the hash picks an arbitrary pod. MCP clients and vendor webhooks carry no cookie and are not pinned at all.

1. **Mutable state is files, and the only locks are in-process.** Two writers lose updates. Needs a transactional store (Postgres) for the mutable records; shared RWX storage does not fix it, and makes appends worse (`O_APPEND` is not atomic across NFS clients).
   - `workspace.json` is replaced whole on every write, and `serializePerWorkspace` (`src/workspace/serialize.ts:26`) serializes within one process only. The notification poller writes a cursor through it every sweep, so a write on one pod can re-add a member removed on another, or drop a connector or route.
   - Notification day files are rewritten whole on a delivery outcome or mark-read (`src/notifications/store.ts`), dropping another pod's appends.
   - Two turns on one conversation interleave appends into its JSONL (`src/conversation/event-sourced-store.ts`).
   - The automation run log prunes with a rewrite; the config override file is read-modify-write.
2. **Work that must happen once runs once per pod.** Needs a lease or a claimed work item per unit of work.
   - The automations scheduler (`src/platform/automations/scheduler.ts:529`) fires every due automation on every pod: N runs, N side effects. Each pod reloads definitions only on its own writes, so one pod keeps firing an automation paused or deleted on another.
   - The notification poller (`src/notifications/poller.ts:59`) reads every outbox once per pod and races the stored cursor; the store's dedupe is find-then-append, not atomic across processes. The route dispatcher's boot `resume` (`src/notifications/routes.ts`) re-sends deliveries another pod has in flight.
   - Hooks provisioning (`src/hooks/reconcile.ts:161`, single-flight per process): two pods each mint a delivery id, the vendor keeps one and `workspace.json` the other, and every delivery then 404s.
   - `ConnectionRevalidator` (`src/connectors/runtime/connection-revalidator.ts`, see `src/connectors/runtime/AGENTS.md`) polls each pod's in-memory connection state: N× the calls against one provider account, and split-brain flips. `on_ready("resume")` goes out once per pod.
3. **Caches and fan-out are per pod.** A change on one pod never reaches the others. Needs cross-pod invalidation and fan-out (pub/sub).
   - Connector instances (`src/connectors/runtime/lifecycle.ts:240`) load at boot and on a local install. An install on one pod is absent on another; an uninstall leaves the connector callable on another pod with its cached tokens. Placements diverge the same way.
   - The WorkOS user cache (`src/identity/providers/workos.ts:219`, 5-minute TTL) is cleared only locally, so a deactivated user keeps access on other pods until it expires. The `/v1/events` membership set (`src/api/events.ts`) refreshes only from local writes, so a removed member keeps receiving that workspace's events on another pod.
   - Every `/v1/events` event and every RunBus frame (`src/runtime/run-bus.ts`) reaches only the emitting pod's clients. A viewer on another pod sees `isActive:false` for an in-flight turn and gets no live frames. Model config set with `set_model_config`, the conversation list index, and relayed server notifications stay on the pod that saw them.
4. **Flows, locks and limits live in one process.** Needs shared locks and counters (Redis or Postgres), and OAuth flow state in a store rather than a promise.
   - Pending login flows (`src/api/handlers.ts:1479`), connector OAuth flows (`src/tools/oauth-flow-registry.ts:82`, which holds an in-process promise) and Composio connect flows: a callback on another pod fails. `lb_cookie` fixes these for a browser, except across a restart.
   - The turn lock (`activeConversations`, `src/runtime/runtime.ts:560`): two pods can run turns on one conversation, and Stop on the other pod cancels nothing. `lb_cookie` fixes it for one browser, not for a second device or an MCP client.
   - One OAuth flow per connector (`authFlowsInFlight` in `lifecycle.ts`) and refresh single-flight with cached tokens (`src/tools/workspace-oauth-provider.ts:699`): with rotating refresh tokens one pod's refresh invalidates the other's, which then records `auth_lost` for everyone.
   - Rate limiters (`src/api/server.ts:153` onward, the hooks buckets, the host-resources bucket, the poll budget) count per pod: the effective limit is ×N.
   - A 2026-07-28 task runs in the `McpSource` of the pod that started it, and its poll carries no session id to route on (`mcp-modern-tasks.ts`).
5. **Infrastructure.** RWX storage or workspace data off the PVC (an RWO volume with `RollingUpdate` deadlocks on attach); `sessionStore.type: "redis"`, a Redis instance per tenant in its own namespace (the default `nb:mcp:session:` prefix assumes that); `platform.strategy.type: RollingUpdate`, only after storage; a tenant quota that fits two runtimes.

**Correctly per-pod: source self-heal.** `ConnectorLifecycleManager.tryRecoverSource` (re-registering a workspace source that is installed but missing from this pod's registry; reached from the orchestrator's tool door and the three REST doors in `src/api/handlers.ts`) and its `recoveryAttempts` cooldown are per-pod by design: `registriesByWs` is process-local and its sources are process-bound transports, so each pod heals its own registry on its own miss. It is reactive and idempotent, touches no shared upstream account, and fans out to nobody, so it needs no leader election; do NOT move the cooldown to Redis, or one pod's failed heal suppresses another's independent miss. It heals only connectors this pod knows: one installed on another pod is item 3.

## Client address

**`clientAddressFor`** (`src/api/client-address.ts`) is the runtime's only
load-bearing `X-Forwarded-For` reader — right-most back `NB_TRUSTED_PROXY_HOPS`
(default 1), never left-most. The two other readers (`auth-middleware.ts`,
`mcp-server.ts`) feed log lines and decide nothing; do not add a third that does.
