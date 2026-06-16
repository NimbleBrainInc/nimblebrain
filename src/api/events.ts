import { log } from "../cli/log.ts";
import type { EngineEvent, EngineEventType, EventSink } from "../engine/types.ts";
import { bareToolName } from "../tools/namespace.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";

/**
 * SSE client connection tracked by the event manager.
 *
 * Workspace-scoped fan-out is filtered through `workspaceMemberships`:
 *
 *   - `undefined` — receive every event regardless of `wsId`. This is the
 *     legacy `addClient()` no-arg semantic, kept for internal consumers
 *     (activity dashboards, tests) that need the unfiltered firehose.
 *   - `Set<string>` — receive only events whose `wsId` is in the set.
 *
 * Identity-scoped clients (the `/v1/events` route) carry both an
 * `identityId` and a memberships set computed from the workspaces the
 * identity belongs to. The set is refreshed when the injected
 * `WorkspaceStore` fires a `membershipChanged` for that identity, so a
 * mid-stream `addMember` / `removeMember` is reflected without a
 * reconnect.
 *
 * Legacy single-workspace clients (`addClient(wsId)`) store a one-element
 * set. The unified filter delivers identical behavior to the prior
 * `client.workspaceId === wsId` check, so all existing tests pass.
 */
interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  /** Identity the connection is bound to. Only set for `addIdentityClient`. */
  identityId?: string;
  /**
   * Workspaces this client should receive events for. `undefined` = no
   * filter (legacy firehose); a `Set` is the explicit allowlist.
   */
  workspaceMemberships?: Set<string>;
}

/** A buffered event retained in the in-memory event buffer. */
export interface BufferedEvent {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

const encoder = new TextEncoder();

/**
 * Per-event-type rule for what `SseEventManager.emit()` does with an
 * `EngineEvent`:
 *
 *   - `scope: "global"`   — broadcast to every connected client (e.g. shared
 *                            config, skills library, workspace-agnostic events)
 *   - `scope: "workspace"` — broadcast only to clients whose
 *                             `workspaceMemberships` includes the event's
 *                             `data[wsIdField]`. The named field MUST be
 *                             present on the event's payload; if it's
 *                             missing we drop the event rather than fan it
 *                             out to every workspace (the alternative leaks
 *                             one workspace's signals to its neighbors).
 *
 * Events with no entry are NOT forwarded — operational events like
 * `tool.progress` / `tool.done` / `run.error` stay internal to the runtime.
 *
 * Adding a new SSE-bound event type is a one-line edit here. The
 * `Partial<Record<EngineEventType, SseRoute>>` shape makes the key a
 * compile-time check against `EngineEventType`, so a typo or a renamed
 * event surfaces as a build error rather than silently no-routing.
 */
type SseRoute = { scope: "global" } | { scope: "workspace"; wsIdField: string };

const SSE_ROUTES: Partial<Record<EngineEventType, SseRoute>> = {
  // Bundle lifecycle — workspace-scoped. `wsId` is on every payload (added
  // in lifecycle.ts when emitting); without it we can't safely scope, so the
  // event drops at the boundary below.
  "bundle.installed": { scope: "workspace", wsIdField: "wsId" },
  "bundle.uninstalled": { scope: "workspace", wsIdField: "wsId" },
  "bundle.crashed": { scope: "workspace", wsIdField: "wsId" },
  "bundle.recovered": { scope: "workspace", wsIdField: "wsId" },
  "bundle.dead": { scope: "workspace", wsIdField: "wsId" },
  // Per-principal connection state — workspace-scoped. Drives the
  // pending-auth banner; without forwarding here, the banner never auto-clears
  // after a user completes interactive OAuth.
  "connection.state_changed": { scope: "workspace", wsIdField: "wsId" },
  // Tool dispatch fan-out used by Synapse `useDataSync`. The data-sync
  // refresh path is workspace-bound at the bridge level (each iframe ships
  // X-Workspace-Id), but the payload doesn't carry wsId today — keeping the
  // existing "broadcast to all clients in this process" behavior to avoid
  // silently breaking iframe refresh. Revisit when payload grows wsId.
  "data.changed": { scope: "global" },
  // Live conversation-title update (auto-title generation completes after the
  // turn). Scoped by the event's `wsId`, which the runtime sets to the OWNER'S
  // PERSONAL workspace (NOT the conversation's workspaceId) — conversations are
  // owner-scoped, so this reaches exactly the owner's tabs. Scoping by the
  // conversation's workspaceId would leak the title to every member of a team
  // workspace; see the rationale at runtime.ts (generateTitle emit). The shell
  // routes it to the matching conversation slice by `conversationId`.
  "conversation.title": { scope: "workspace", wsIdField: "wsId" },
  // Org-level config (model preferences, feature flags). Affects every
  // workspace; broadcast to all.
  "config.changed": { scope: "global" },
  // Skills library — global state shared across workspaces.
  "skill.created": { scope: "global" },
  "skill.updated": { scope: "global" },
  "skill.deleted": { scope: "global" },
  // Bridge tool call/done — emitted by the iframe→/v1/tools/call shim.
  // Field name is `workspaceId` (not `wsId`) — see handlers.ts emit sites.
  "bridge.tool.call": { scope: "workspace", wsIdField: "workspaceId" },
  "bridge.tool.done": { scope: "workspace", wsIdField: "workspaceId" },
};

/**
 * Derive the `data.changed` broadcast target (`{ server, tool }`) from a tool
 * lifecycle event, or `null` when the event must not broadcast.
 *
 * Two event shapes feed this, and they carry the source name differently:
 *   - `tool.done` (ok) → a single qualified `name`. This is the name the
 *     MODEL called, which post-Stage-2 is workspace-namespaced
 *     (`ws_<id>-<source>__<tool>`).
 *   - `tool.progress` → separate `source` + `tool`; `McpSource` emits the
 *     bare source name there.
 *
 * Both are normalized to the **bare** source name via `bareToolName` before
 * the `__` split. This is load-bearing: the Synapse `useDataSync` consumer
 * matches the broadcast `server` against the iframe's `data-app`, which is the
 * bare placement `serverName` (see `PlacementRegistry` — serverName and wsId
 * are stored as separate fields). A namespaced `server` never matches, so the
 * iframe would only refresh on remount (the "click off and back" symptom).
 * Stripping the prefix also restores the `nb` system-tool guard:
 * `ws_<id>-nb__x` → `nb__x` → server `nb`, which we skip (system tools don't
 * mutate app data, and broadcasting for them re-fetches every streaming chunk).
 *
 * `data.changed` remains workspace-blind (`scope: "global"`, matched on bare
 * server) — the pre-Stage-2 contract. Growing `wsId` into the payload for
 * true per-workspace scoping is tracked separately (see `SSE_ROUTES`).
 */
export function deriveDataChangedTarget(
  event: EngineEvent,
): { server: string; tool: string } | null {
  const isBroadcast =
    (event.type === "tool.done" && event.data.ok === true) || event.type === "tool.progress";
  if (!isBroadcast) return null;

  const { name, source, tool: toolField } = event.data;
  const rawName =
    typeof name === "string"
      ? name
      : typeof source === "string" && typeof toolField === "string"
        ? `${source}__${toolField}`
        : undefined;
  if (!rawName) return null;

  // Strip any `ws_<id>-` workspace prefix, then split source from tool on the
  // first `__`. A bare source name with hyphens (`synapse-db-query`) is left
  // intact — `bareToolName` only strips a leading segment matching the
  // workspace-id pattern.
  const bare = bareToolName(rawName);
  const sepIndex = bare.indexOf("__");
  const server = sepIndex !== -1 ? bare.slice(0, sepIndex) : bare;
  const tool = sepIndex !== -1 ? bare.slice(sepIndex + 2) : bare;

  // System tools (`nb__*`) don't modify app data; broadcasting for them makes
  // iframes re-fetch on every streaming chunk (flicker + tool-call amplification).
  if (server === "nb") return null;

  return { server, tool };
}

/**
 * SSE Event Manager for the workspace-level event stream.
 *
 * Tracks connected SSE clients, broadcasts events per the `SSE_ROUTES`
 * table, and sends heartbeats at a configurable interval (default 30s).
 *
 * Maintains a bounded in-memory event buffer so that consumers (e.g.
 * ActivityCollector) can query recent events without being SSE clients.
 *
 * **Identity-scoped clients.** The `/v1/events` route uses
 * `addIdentityClient`, which binds a connection to an identity and caches
 * the set of workspaces the identity is a member of. The cache is
 * refreshed in-process when the injected `WorkspaceStore` fires a
 * membership change, so workspace switches don't churn the SSE.
 * Authorization happens at emit time against the cached set — same
 * `WorkspaceStore` that gates every other authorization path.
 */
export class SseEventManager implements EventSink {
  private clients = new Map<string, SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private eventBuffer: BufferedEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 500;
  private localListeners = new Set<(event: string, data: Record<string, unknown>) => void>();
  private workspaceStore?: WorkspaceStore;
  private unsubscribeMembership: (() => void) | null = null;

  /**
   * @param heartbeatIntervalMs - heartbeat cadence in ms. Default 30s.
   * @param workspaceStore - optional. When supplied, `addIdentityClient`
   *   queries it for memberships and the manager refreshes a client's
   *   cached set on membership-change events. Tests and internal
   *   consumers that only use `addClient()` may omit it.
   */
  constructor(heartbeatIntervalMs = 30_000, workspaceStore?: WorkspaceStore) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.workspaceStore = workspaceStore;
  }

  /** Start the heartbeat timer and (if a workspace store is wired) the membership-change subscription. */
  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcast("heartbeat", {
        timestamp: new Date().toISOString(),
      });
    }, this.heartbeatIntervalMs);

    if (this.workspaceStore && !this.unsubscribeMembership) {
      this.unsubscribeMembership = this.workspaceStore.onMembershipChanged((userId) => {
        // Fire-and-forget; the refresh is async (disk I/O). Errors are
        // caught and logged so the workspace mutation that triggered us
        // never sees an exception bubble out.
        void this.refreshMembershipsForIdentity(userId).catch((err) => {
          log.warn("[events] membership refresh failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    }
  }

  /** Stop timers, unsubscribe membership listener, and close all clients. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.unsubscribeMembership) {
      this.unsubscribeMembership();
      this.unsubscribeMembership = null;
    }
    for (const client of this.clients.values()) {
      this.closeClient(client);
    }
    this.clients.clear();
  }

  /** Number of connected SSE clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Create an SSE stream for a legacy workspace-scoped or unfiltered
   * client.
   *
   *   - `addClient()` — no filter; receives every event.
   *   - `addClient(wsId)` — single-workspace filter; receives events
   *     where `event.wsId === wsId` plus all global events.
   *
   * **No production caller today.** Both forms are kept solely as the
   * surface that the V5 workspace-isolation security regression tests
   * (`test/integration/security/workspace-isolation.test.ts`) and the
   * `SseEventManager` routing-table unit tests
   * (`test/unit/sse-event-manager.test.ts`) were written against. Those
   * suites lock in the workspace-isolation contract under the legacy
   * frozen-workspace model; migrating them to `addIdentityClient` would
   * subtly change what they assert. Production code uses
   * `addIdentityClient` via the `/v1/events` route.
   */
  addClient(workspaceId?: string): ReadableStream<Uint8Array> {
    return this.attachClient({
      workspaceMemberships: workspaceId ? new Set([workspaceId]) : undefined,
    });
  }

  /**
   * Create an SSE stream bound to an identity. The connection receives
   * events for any workspace currently in the identity's membership set,
   * plus all global events. The set is refreshed automatically when the
   * workspace store fires a `membershipChanged` for `identityId`.
   *
   * `memberships` is the initial set, typically computed by the caller
   * via `workspaceStore.getWorkspacesForUser(identityId)`. An empty set
   * means "global events only" — distinct from legacy `addClient()`
   * which receives the workspace firehose unfiltered.
   */
  addIdentityClient(identityId: string, memberships: Set<string>): ReadableStream<Uint8Array> {
    return this.attachClient({
      identityId,
      workspaceMemberships: memberships,
    });
  }

  /** Shared client-attachment path. */
  private attachClient(opts: {
    identityId?: string;
    workspaceMemberships?: Set<string>;
  }): ReadableStream<Uint8Array> {
    const id = crypto.randomUUID();

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const client: SseClient = {
          id,
          controller,
          closed: false,
          identityId: opts.identityId,
          workspaceMemberships: opts.workspaceMemberships,
        };
        this.clients.set(id, client);
      },
      cancel: () => {
        this.removeClient(id);
      },
    });
  }

  /**
   * EventSink implementation: forward events to SSE clients per the
   * `SSE_ROUTES` table at the top of this file. Events with no route entry
   * are dropped (kept internal to the runtime); workspace-scoped events
   * are filtered to clients whose cached memberships include the event's
   * workspace id.
   */
  emit(event: EngineEvent): void {
    const route = SSE_ROUTES[event.type];
    if (!route) return;
    if (route.scope === "global") {
      this.broadcast(event.type, event.data);
      return;
    }
    // Workspace-scoped: extract the wsId from the declared field. A
    // missing wsId is a payload bug — drop rather than fan out to every
    // workspace, since that would leak one workspace's signals to others.
    const wsId = event.data[route.wsIdField];
    if (typeof wsId !== "string" || wsId.length === 0) return;
    this.broadcast(event.type, event.data, wsId);
  }

  /**
   * Broadcast an SSE event to connected clients, optionally filtered by
   * workspace.
   *
   * Filter rules per client:
   *   - No `wsId` passed (global / heartbeat) → enqueue unconditionally.
   *   - `client.workspaceMemberships === undefined` → legacy firehose;
   *     enqueue. Internal consumers only — the public `/v1/events` route
   *     never produces this shape.
   *   - `client.workspaceMemberships.has(wsId)` → enqueue.
   *   - Otherwise → skip.
   */
  broadcast(eventType: string, data: Record<string, unknown>, wsId?: string): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(message);

    for (const [id, client] of this.clients) {
      if (client.closed) {
        this.clients.delete(id);
        continue;
      }
      if (wsId !== undefined) {
        const memberships = client.workspaceMemberships;
        // `undefined` = legacy firehose; any non-undefined set requires
        // explicit membership to deliver.
        if (memberships !== undefined && !memberships.has(wsId)) continue;
      }
      try {
        client.controller.enqueue(encoded);
      } catch (err) {
        // Client disconnected — log before cleanup
        log.warn("[events] SSE write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.closeClient(client);
        this.clients.delete(id);
      }
    }

    // Buffer the event
    const buffered: BufferedEvent = {
      event: eventType,
      data,
      timestamp: new Date().toISOString(),
    };
    if (this.eventBuffer.length >= this.MAX_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }
    this.eventBuffer.push(buffered);

    // Notify local listeners
    for (const cb of this.localListeners) {
      cb(eventType, data);
    }
  }

  /**
   * Return buffered events with timestamp >= the given ISO string.
   * Uses lexicographic comparison on ISO-8601 timestamps.
   */
  getEventsSince(since: string): BufferedEvent[] {
    return this.eventBuffer.filter((e) => e.timestamp >= since);
  }

  /**
   * Register a local listener that is called on every broadcast.
   * Useful for in-process consumers (caches, dashboards) that need
   * event-driven invalidation without being an SSE client.
   */
  onEvent(callback: (event: string, data: Record<string, unknown>) => void): void {
    this.localListeners.add(callback);
  }

  /**
   * Refresh the cached workspace-memberships set for every identity-bound
   * client whose identity matches `userId`. Called from the workspace
   * store's membership-change listener (wired in `start()`). Idempotent
   * and tolerant of clients disconnecting mid-refresh.
   */
  private async refreshMembershipsForIdentity(userId: string): Promise<void> {
    if (!this.workspaceStore) return;
    // Collect matching clients up front so we re-query the store once
    // even if several connections share an identity.
    const matching: SseClient[] = [];
    for (const client of this.clients.values()) {
      if (client.closed) continue;
      if (client.identityId === userId) matching.push(client);
    }
    if (matching.length === 0) return;

    const workspaces = await this.workspaceStore.getWorkspacesForUser(userId);
    const fresh = new Set(workspaces.map((ws) => ws.id));
    for (const client of matching) {
      if (client.closed) continue;
      client.workspaceMemberships = fresh;
    }
  }

  private removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      this.closeClient(client);
      this.clients.delete(id);
    }
  }

  private closeClient(client: SseClient): void {
    if (client.closed) return;
    client.closed = true;
    try {
      client.controller.close();
    } catch {
      // Already closed
    }
  }
}
