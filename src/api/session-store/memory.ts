/**
 * In-memory session registry — process-local, no external dependencies.
 *
 * Default for dev, tests, and any single-replica deploy that doesn't need
 * cluster-wide visibility. Drop-in equivalent to the bare `Map` the legacy
 * `mcp-server.ts` carried, with the registry interface bolted on so the
 * call sites match the Redis path exactly.
 *
 * TTL is enforced by a periodic sweep — no native expiry on `Map`. Sweep
 * interval defaults to 60s, matching the legacy implementation. The
 * interval is `unref`d so it never holds the process open during shutdown.
 */

import type { SessionMeta, SessionRegistry } from "./types.ts";

export interface InMemorySessionRegistryOptions {
  /** Idle TTL in milliseconds. Sessions older than this are evicted on sweep. */
  ttlMs: number;
  /** Sweep interval in milliseconds. Default: 60s. */
  sweepIntervalMs?: number;
}

export class InMemorySessionRegistry implements SessionRegistry {
  private readonly entries = new Map<string, SessionMeta>();
  private readonly ttlMs: number;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(opts: InMemorySessionRegistryOptions) {
    this.ttlMs = opts.ttlMs;
    const interval = opts.sweepIntervalMs ?? 60_000;
    this.sweepInterval = setInterval(() => {
      this.sweepExpired(Date.now()).catch(() => {
        // sweep is best-effort and synchronous internally; nothing to handle
      });
    }, interval);
    // Don't pin the event loop open just because the registry is alive.
    if (typeof this.sweepInterval === "object" && "unref" in this.sweepInterval) {
      this.sweepInterval.unref();
    }
  }

  async create(meta: SessionMeta): Promise<void> {
    this.entries.set(meta.sessionId, { ...meta });
  }

  async get(sessionId: string): Promise<SessionMeta | null> {
    const meta = this.entries.get(sessionId);
    if (!meta) return null;
    // TTL check on read so we never return a stale entry that the next
    // sweep would have evicted.
    if (Date.now() - meta.lastAccessedAt > this.ttlMs) {
      this.entries.delete(sessionId);
      return null;
    }
    return { ...meta };
  }

  async touch(sessionId: string, now: number): Promise<void> {
    const meta = this.entries.get(sessionId);
    if (!meta) return;
    meta.lastAccessedAt = now;
  }

  async delete(sessionId: string): Promise<void> {
    this.entries.delete(sessionId);
  }

  async sweepExpired(now: number): Promise<void> {
    for (const [sid, meta] of this.entries) {
      if (now - meta.lastAccessedAt > this.ttlMs) {
        this.entries.delete(sid);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweepInterval);
    this.entries.clear();
  }

  /** Test-only: number of currently tracked sessions. */
  size(): number {
    return this.entries.size;
  }
}
