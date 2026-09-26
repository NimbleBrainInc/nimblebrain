/**
 * Session-store compatibility: the workspace a session is bound to.
 *
 * A `/mcp` session is bound to (identity, workspace), and both
 * `SessionRegistry` implementations record the workspace:
 *
 *   - `create` → `get` round-trips `workspaceId`, because a session-miss
 *     answer compares it before confirming a live session to a caller.
 *
 *   - An entry written without one (a hash that predates the field) loads
 *     without error and reads `workspaceId: null`, which matches no caller's
 *     workspace — so it is never confirmed to anyone.
 *
 * Lives in `test/integration/` because it exercises the cluster-shared
 * registry contract end-to-end (including the Redis fake), not just the
 * type surface. The unit-tier `conformance.ts` covers behavior.
 */

import { describe, expect, it } from "bun:test";
import { InMemorySessionRegistry } from "../../src/api/session-store/memory.ts";
import { type RedisLike, RedisSessionRegistry } from "../../src/api/session-store/redis.ts";

class FakeRedis implements RedisLike {
  private hashes = new Map<string, Map<string, string>>();
  private expiries = new Map<string, number>();

  async connect(): Promise<unknown> {
    return undefined;
  }

  close(): unknown {
    this.hashes.clear();
    this.expiries.clear();
    return undefined;
  }

  /** Test-only: hydrate a legacy hash directly, bypassing `HSET`. */
  seedHash(key: string, fields: Record<string, string>): void {
    const h = new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) h.set(k, v);
    this.hashes.set(key, h);
    this.expiries.set(key, Date.now() + 60_000);
  }

  async send(command: string, args: string[]): Promise<unknown> {
    switch (command.toUpperCase()) {
      case "HSET": {
        const [key, ...pairs] = args;
        if (!key) throw new Error("HSET requires key");
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        for (let i = 0; i < pairs.length; i += 2) {
          hash.set(pairs[i] ?? "", pairs[i + 1] ?? "");
        }
        this.hashes.set(key, hash);
        return pairs.length / 2;
      }
      case "HGETALL": {
        const [key] = args;
        if (!key) return {};
        const hash = this.hashes.get(key);
        if (!hash) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of hash) out[k] = v;
        return out;
      }
      case "EXISTS": {
        const [key] = args;
        return key && this.hashes.has(key) ? 1 : 0;
      }
      case "PEXPIRE": {
        const [key, ttl] = args;
        if (!key || ttl === undefined) return 0;
        if (!this.hashes.has(key)) return 0;
        this.expiries.set(key, Date.now() + Number(ttl));
        return 1;
      }
      case "DEL": {
        const [key] = args;
        if (!key) return 0;
        const had = this.hashes.delete(key);
        this.expiries.delete(key);
        return had ? 1 : 0;
      }
      default:
        throw new Error(`FakeRedis: unsupported command ${command}`);
    }
  }
}

const SAMPLE_SID = "abcdef01-2222-3333-4444-555555555555";

describe("session-store — the workspace binding", () => {
  describe("InMemorySessionRegistry", () => {
    it("round-trips the session's workspaceId", async () => {
      const reg = new InMemorySessionRegistry({ ttlMs: 60_000 });
      try {
        const now = Date.now();
        await reg.create({
          sessionId: SAMPLE_SID,
          identityId: "usr_42",
          workspaceId: "ws_a",
          createdAt: now,
          lastAccessedAt: now,
        });
        const got = await reg.get(SAMPLE_SID);
        expect(got?.workspaceId).toBe("ws_a");
        expect(got?.identityId).toBe("usr_42");
      } finally {
        await reg.shutdown();
      }
    });
  });

  describe("RedisSessionRegistry", () => {
    it("round-trips the session's workspaceId", async () => {
      const client = new FakeRedis();
      const reg = new RedisSessionRegistry({
        url: "redis://fake",
        ttlMs: 60_000,
        client,
      });
      try {
        const now = Date.now();
        await reg.create({
          sessionId: SAMPLE_SID,
          identityId: "usr_42",
          workspaceId: "ws_a",
          createdAt: now,
          lastAccessedAt: now,
        });
        const got = await reg.get(SAMPLE_SID);
        expect(got?.workspaceId).toBe("ws_a");
        expect(got?.identityId).toBe("usr_42");
      } finally {
        await reg.shutdown();
      }
    });

    it("an entry with no workspaceId loads, and reads null", async () => {
      const client = new FakeRedis();
      const now = Date.now();
      client.seedHash("nb:mcp:session:older-sid", {
        sessionId: "older-sid",
        identityId: "usr_older",
        createdAt: String(now),
        lastAccessedAt: String(now),
      });

      const reg = new RedisSessionRegistry({
        url: "redis://fake",
        ttlMs: 60_000,
        client,
      });
      try {
        const got = await reg.get("older-sid");
        expect(got).not.toBeNull();
        expect(got?.sessionId).toBe("older-sid");
        expect(got?.identityId).toBe("usr_older");
        expect(got?.createdAt).toBe(now);
        expect(got?.workspaceId).toBeNull();
      } finally {
        await reg.shutdown();
      }
    });
  });
});
