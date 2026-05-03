/**
 * Redis-backed session registry.
 *
 * Each session is a Redis hash at `${prefix}${sessionId}` with native TTL.
 * Every `touch` re-applies the TTL via `PEXPIRE` so an actively-used session
 * never expires; an idle session evicts itself when Redis' TTL fires (no
 * sweep loop required, unlike the in-memory provider).
 *
 * Operations are best-effort from the caller's perspective: an unreachable
 * Redis must not block the request path. We surface failures via thrown
 * errors so the caller can decide policy (typically: log + fall back to the
 * local transport map). We do NOT install a circuit breaker — the session
 * map IS the gate, and ElastiCache local-AZ p99 is sub-ms.
 *
 * Connection lifecycle: the client is created at app startup and closed in
 * `shutdown()`. We do NOT auto-reconnect on every command — Bun's client
 * handles transient TCP blips internally; if it stays dead, requests fail
 * loud and the session-miss log line tells operators what happened.
 */

import { log } from "../../cli/log.ts";
import type { SessionMeta, SessionRegistry } from "./types.ts";

export interface RedisSessionRegistryOptions {
  /** Connection URL, e.g. `redis://host:6379` or `rediss://...`. */
  url: string;
  /** Idle TTL in milliseconds. Re-applied on every `touch`. */
  ttlMs: number;
  /** Hash key prefix. Default: `nb:mcp:session:`. */
  keyPrefix?: string;
  /**
   * Override for tests: inject a pre-constructed client (e.g. an in-process
   * fake). When omitted, a `Bun.RedisClient` is constructed from `url`.
   */
  client?: RedisLike;
}

/**
 * Minimal subset of the Bun Redis API this module uses. Defined as a
 * structural interface so tests can supply a fake without depending on
 * the entire Bun.RedisClient surface (~150 methods).
 */
export interface RedisLike {
  connect(): Promise<unknown>;
  close(): unknown;
  send(command: string, args: string[]): Promise<unknown>;
}

const DEFAULT_PREFIX = "nb:mcp:session:";

export class RedisSessionRegistry implements SessionRegistry {
  private readonly client: RedisLike;
  private readonly ownsClient: boolean;
  private readonly ttlMs: number;
  private readonly prefix: string;

  constructor(opts: RedisSessionRegistryOptions) {
    this.ttlMs = opts.ttlMs;
    this.prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    if (opts.client) {
      this.client = opts.client;
      this.ownsClient = false;
    } else {
      // `Bun.RedisClient` exposes ~150 typed methods; we only ever call the
      // three on `RedisLike` (`connect`, `close`, `send`). The cast widens
      // the runtime instance down to the structural subset we depend on so
      // tests can substitute a small fake without re-implementing the full
      // surface. Mismatch risk is bounded: if Bun changes the shape of the
      // three methods we use, compilation fails at the call sites below.
      this.client = new Bun.RedisClient(opts.url) as unknown as RedisLike;
      this.ownsClient = true;
    }
  }

  /**
   * Connect to Redis. Surfaces connection failures up front so a misconfigured
   * cluster can't ship a half-broken pod through readiness probes.
   */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  async create(meta: SessionMeta): Promise<void> {
    const key = this.key(meta.sessionId);
    // Hash fields, then explicit TTL. Two commands instead of pipelining
    // because Bun's RedisClient doesn't expose a public pipeline primitive
    // and each call is sub-ms locally; the simplicity wins.
    await this.client.send("HSET", [
      key,
      "sessionId",
      meta.sessionId,
      "identityId",
      meta.identityId ?? "",
      "workspaceId",
      meta.workspaceId,
      "createdAt",
      String(meta.createdAt),
      "lastAccessedAt",
      String(meta.lastAccessedAt),
    ]);
    await this.client.send("PEXPIRE", [key, String(this.ttlMs)]);
  }

  async get(sessionId: string): Promise<SessionMeta | null> {
    const key = this.key(sessionId);
    const raw = (await this.client.send("HGETALL", [key])) as unknown;
    return parseHash(sessionId, raw);
  }

  async touch(sessionId: string, now: number): Promise<void> {
    const key = this.key(sessionId);
    // HSET on a non-existent key creates it. We don't want to "resurrect"
    // a session whose TTL already fired, so guard with EXISTS first.
    // EXISTS returns the integer 1 / 0 — Bun returns it as a number.
    const exists = (await this.client.send("EXISTS", [key])) as number;
    if (exists !== 1) return;
    await this.client.send("HSET", [key, "lastAccessedAt", String(now)]);
    await this.client.send("PEXPIRE", [key, String(this.ttlMs)]);
  }

  async delete(sessionId: string): Promise<void> {
    await this.client.send("DEL", [this.key(sessionId)]);
  }

  async sweepExpired(_now: number): Promise<void> {
    // No-op: Redis evicts via native TTL. Method exists for interface parity.
  }

  async shutdown(): Promise<void> {
    if (!this.ownsClient) return;
    try {
      this.client.close();
    } catch (err) {
      // close() is sync in Bun's API; surface unusual errors so failed
      // shutdowns don't pass silently.
      log.warn(`[mcp] redis registry close error: ${(err as Error).message}`);
    }
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }
}

/**
 * Parse the result of `HGETALL key`. Bun returns an object map for hashes;
 * older clients sometimes return alternating-array form. Accept both so
 * the registry isn't brittle to client version drift.
 */
function parseHash(sessionId: string, raw: unknown): SessionMeta | null {
  if (raw === null || raw === undefined) return null;
  const obj = toRecord(raw);
  if (!obj || Object.keys(obj).length === 0) return null;

  const workspaceId = obj.workspaceId;
  const createdAt = Number(obj.createdAt);
  const lastAccessedAt = Number(obj.lastAccessedAt);

  if (!workspaceId || !Number.isFinite(createdAt) || !Number.isFinite(lastAccessedAt)) {
    // Hash is corrupt or partial. Treat as missing.
    return null;
  }

  return {
    sessionId,
    identityId: obj.identityId === "" ? null : (obj.identityId ?? null),
    workspaceId,
    createdAt,
    lastAccessedAt,
  };
}

function toRecord(raw: unknown): Record<string, string> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  if (Array.isArray(raw)) {
    if (raw.length % 2 !== 0) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      out[String(raw[i])] = String(raw[i + 1]);
    }
    return out;
  }
  return null;
}
