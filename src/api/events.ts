import type { EngineEvent, EngineEventType, EventSink } from "../engine/types.ts";

/** SSE client connection tracked by the event manager. */
interface SseClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  workspaceId?: string;
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
 *   - `scope: "workspace"` — broadcast only to clients whose `workspaceId`
 *                             matches `data[wsIdField]`. The named field MUST
 *                             be present on the event's payload; if it's
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
 * SSE Event Manager for the workspace-level event stream (PRODUCT_SPEC ss9.3).
 *
 * Tracks connected SSE clients, broadcasts events to all clients, and sends
 * heartbeats at a configurable interval (default 30s).
 *
 * Maintains a bounded in-memory event buffer so that consumers (e.g.
 * ActivityCollector) can query recent events without being SSE clients.
 */
export class SseEventManager implements EventSink {
  private clients = new Map<string, SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;
  private eventBuffer: BufferedEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 500;
  private localListeners = new Set<(event: string, data: Record<string, unknown>) => void>();

  constructor(heartbeatIntervalMs = 30_000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  /** Start the heartbeat timer. */
  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcast("heartbeat", {
        timestamp: new Date().toISOString(),
      });
    }, this.heartbeatIntervalMs);
  }

  /** Stop the heartbeat timer and close all clients. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
   * Create a new SSE ReadableStream for a connecting client.
   * Returns the stream to be used as the Response body.
   */
  addClient(workspaceId?: string): ReadableStream<Uint8Array> {
    const id = crypto.randomUUID();
    let client: SseClient;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { id, controller, closed: false, workspaceId };
        this.clients.set(id, client);
      },
      cancel: () => {
        this.removeClient(id);
      },
    });

    return stream;
  }

  /**
   * EventSink implementation: forward events to SSE clients per the
   * `SSE_ROUTES` table at the top of this file. Events with no route entry
   * are dropped (kept internal to the runtime); workspace-scoped events
   * are filtered to clients with a matching workspace id.
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

  /** Broadcast an SSE event to connected clients, optionally filtered by workspace. */
  broadcast(eventType: string, data: Record<string, unknown>, wsId?: string): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(message);

    for (const [id, client] of this.clients) {
      if (client.closed) {
        this.clients.delete(id);
        continue;
      }
      // Skip clients from other workspaces (null wsId = broadcast to all, e.g. heartbeat)
      if (wsId && client.workspaceId && client.workspaceId !== wsId) continue;
      try {
        client.controller.enqueue(encoded);
      } catch (err) {
        // Client disconnected — log before cleanup
        console.warn("[events] SSE write failed:", err);
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
