/**
 * Stage 2 (cross-workspace refactor) Task 007 — session-store legacy
 * compatibility tests.
 *
 * Pins the Q4 (hard-cut) contract on both `SessionRegistry`
 * implementations:
 *
 *   - `create` → `get` round-trip never surfaces `workspaceId` (the
 *     field is gone from `SessionMeta`). Pre-Stage-2 test fixtures
 *     that still set the field on the wire would have caught this; we
 *     assert it here for forward safety.
 *
 *   - A legacy entry whose underlying storage still carries a stray
 *     `workspaceId` (pre-Stage-2 Redis hashes survive on-disk; the
 *     in-memory map is irrelevant since the type drop applies at
 *     module load) MUST load without error and MUST NOT surface the
 *     field on the parsed `SessionMeta`. The cut is permanent; readers
 *     ignore the legacy field rather than failing on it.
 *
 * Lives in `test/integration/` because it exercises the cluster-shared
 * registry contract end-to-end (including the Redis fake), not just the
 * type surface. The unit-tier `conformance.ts` covers behavior; this
 * file covers the Stage-2 schema cut specifically.
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

describe("session-store — Stage 2 hard cut (T007)", () => {
  describe("InMemorySessionRegistry", () => {
    it("round-trip surfaces no workspaceId on the parsed SessionMeta", async () => {
      const reg = new InMemorySessionRegistry({ ttlMs: 60_000 });
      try {
        const now = Date.now();
        await reg.create({
          sessionId: SAMPLE_SID,
          identityId: "usr_42",
          createdAt: now,
          lastAccessedAt: now,
        });
        const got = await reg.get(SAMPLE_SID);
        expect(got).not.toBeNull();
        expect((got as unknown as { workspaceId?: unknown }).workspaceId).toBeUndefined();
        expect(got?.identityId).toBe("usr_42");
      } finally {
        await reg.shutdown();
      }
    });
  });

  describe("RedisSessionRegistry", () => {
    it("round-trip surfaces no workspaceId on the parsed SessionMeta", async () => {
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
          createdAt: now,
          lastAccessedAt: now,
        });
        const got = await reg.get(SAMPLE_SID);
        expect(got).not.toBeNull();
        expect((got as unknown as { workspaceId?: unknown }).workspaceId).toBeUndefined();
        expect(got?.identityId).toBe("usr_42");
      } finally {
        await reg.shutdown();
      }
    });

    it("legacy entry with a stray workspaceId loads without error (ignore-unknown)", async () => {
      const client = new FakeRedis();
      // Seed a pre-Stage-2 hash directly — includes `workspaceId` field
      // that a current-version registry would NEVER write but that any
      // long-running Redis instance still carries until it TTLs out.
      const now = Date.now();
      client.seedHash("nb:mcp:session:legacy-sid", {
        sessionId: "legacy-sid",
        identityId: "usr_legacy",
        workspaceId: "ws_legacy_value", // legacy field
        createdAt: String(now),
        lastAccessedAt: String(now),
      });

      const reg = new RedisSessionRegistry({
        url: "redis://fake",
        ttlMs: 60_000,
        client,
      });
      try {
        const got = await reg.get("legacy-sid");
        expect(got).not.toBeNull();
        // Required fields parse correctly.
        expect(got?.sessionId).toBe("legacy-sid");
        expect(got?.identityId).toBe("usr_legacy");
        expect(got?.createdAt).toBe(now);
        expect(got?.lastAccessedAt).toBe(now);
        // The stray legacy field is IGNORED — the parsed shape carries
        // only the documented fields.
        expect((got as unknown as { workspaceId?: unknown }).workspaceId).toBeUndefined();
      } finally {
        await reg.shutdown();
      }
    });
  });
});
