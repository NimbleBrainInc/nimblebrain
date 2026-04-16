import type { EngineEvent, EventSink } from "../engine/types.ts";

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
   * EventSink implementation: forward relevant events to all SSE clients.
   * Only forwards bundle.* and data.changed events.
   */
  emit(event: EngineEvent): void {
    const type = event.type;
    if (
      type === "bundle.installed" ||
      type === "bundle.uninstalled" ||
      type === "bundle.crashed" ||
      type === "bundle.recovered" ||
      type === "bundle.dead" ||
      type === "bundle.start_failed" ||
      type === "data.changed" ||
      type === "config.changed" ||
      type === "skill.created" ||
      type === "skill.updated" ||
      type === "skill.deleted" ||
      type === "bridge.tool.call" ||
      type === "bridge.tool.done"
    ) {
      this.broadcast(type, event.data);
    }
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
   * Useful for in-process consumers (e.g. HomeService) that need
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
