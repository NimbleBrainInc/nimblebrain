/**
 * Session metadata + cluster-shared registry for MCP HTTP sessions.
 *
 * Two layers cooperate to handle MCP Streamable-HTTP sessions:
 *
 *   1. **Transport map** — process-local `Map<sessionId, transport>` in
 *      `mcp-server.ts`. Owns the live HTTP response handles, the SDK
 *      `Server` instance with its registered handlers, and any in-flight
 *      JSON-RPC state. Process-bound; cannot be serialized or moved.
 *
 *   2. **SessionRegistry** (this module) — pluggable metadata store. Knows
 *      that a session exists, when it was last touched, and the identity
 *      and workspace it's bound to. Used to:
 *        - tell `not_found` ("session never existed / TTL'd") apart from
 *          `unavailable` ("exists, but the live transport isn't on this
 *          process") in 404 responses, so operators can correlate
 *        - share TTL semantics across replicas via the underlying store
 *        - observe in-flight sessions cluster-wide for ops/admin tooling
 *
 * The registry is **deliberately deployment-vocabulary-free**: no pod, no
 * instance, no ownership. Routing live requests to the process that owns a
 * given session's transport is the load balancer's job (sticky cookie, or
 * header-hash on `Mcp-Session-Id`), not the registry's. Treating the
 * registry as a router would either re-introduce process identity into
 * the metadata schema or pull cross-process proxying into the application
 * layer — both of which leak into a clean interface.
 *
 * A session is bound to one (identity, workspace): the workspace is the one
 * in the URL it was initialized at (`/mcp/<wsId>`). The registry records both
 * so a session-miss answer can confirm a live session only to the caller it is
 * bound to. An entry with no `workspaceId` reads as `null` and matches no
 * caller.
 *
 * Implementations: `InMemorySessionRegistry` (default; single-replica) and
 * `RedisSessionRegistry` (multi-replica). The interface intentionally
 * matches a TTL-keyed K/V — Redis maps natively, the in-memory version
 * sweeps a `Map` on a periodic timer.
 */

export interface SessionMeta {
  sessionId: string;
  /** Identity that initialized the session (for cross-tenant correlation). */
  identityId: string | null;
  /** Workspace whose URL the session was initialized at; `null` when unrecorded. */
  workspaceId: string | null;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Pluggable session metadata store.
 *
 * All operations are best-effort: failures must not block the request path.
 * The transport map is the source of truth for "can I serve this session";
 * the registry is supplementary metadata. Callers MUST tolerate registry
 * outages (Redis down → log + continue with local map).
 *
 * Implementations are responsible for their own TTL semantics. In-memory
 * runs a periodic sweep; Redis sets native TTLs and re-`EXPIRE`s on `touch`.
 */
export interface SessionRegistry {
  /** Record a freshly-initialized session. */
  create(meta: SessionMeta): Promise<void>;
  /** Look up metadata. Returns null when the session is unknown or expired. */
  get(sessionId: string): Promise<SessionMeta | null>;
  /** Update `lastAccessedAt` and reset the TTL. No-op for unknown sessions. */
  touch(sessionId: string, now: number): Promise<void>;
  /** Remove the session from the registry. No-op for unknown sessions. */
  delete(sessionId: string): Promise<void>;
  /**
   * Best-effort housekeeping. In-memory: scans the map.
   * Redis: no-op (server-side TTL evicts).
   */
  sweepExpired(now: number): Promise<void>;
  /** Stop background work, release connections. */
  shutdown(): Promise<void>;
}
