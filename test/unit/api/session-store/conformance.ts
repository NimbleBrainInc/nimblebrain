/**
 * Provider-agnostic conformance suite for `SessionRegistry`. Both
 * `InMemorySessionRegistry` and `RedisSessionRegistry` must pass it.
 *
 * Tests assert behavior, not implementation: what `get`/`touch`/`delete`
 * return for a given sequence of operations. Callers wrap this in a
 * `describe(...)` block of their own and pass a factory.
 */

import { describe, expect, it } from "bun:test";
import type { SessionMeta, SessionRegistry } from "../../../../src/api/session-store/index.ts";

export interface ConformanceFactoryOptions {
  /** Idle TTL the registry should be configured with. */
  ttlMs: number;
  /** Sweep interval (in-memory only). Tests rely on short intervals to advance time. */
  sweepIntervalMs?: number;
}

export type ConformanceFactory = (opts: ConformanceFactoryOptions) => Promise<SessionRegistry>;

/**
 * Run the full conformance suite against `factory`. Caller wraps in its
 * own `describe(...)` so output groups by provider.
 */
export function registrySpec(factory: ConformanceFactory): void {
  const sample = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
    const now = Date.now();
    return {
      sessionId: "11111111-2222-3333-4444-555555555555",
      identityId: "usr_42",
      workspaceId: "ws_test",
      // Use real wall-clock time so providers that compare against `Date.now()`
      // (the in-memory sweep, the Redis TTL) treat the entry as freshly-created.
      createdAt: now,
      lastAccessedAt: now,
      ...overrides,
    };
  };

  it("get returns null for an unknown session", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      expect(await reg.get("does-not-exist")).toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  it("create then get returns the same metadata", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      const meta = sample();
      await reg.create(meta);
      const got = await reg.get(meta.sessionId);
      expect(got).not.toBeNull();
      expect(got?.sessionId).toBe(meta.sessionId);
      expect(got?.identityId).toBe(meta.identityId);
      expect(got?.workspaceId).toBe(meta.workspaceId);
      expect(got?.createdAt).toBe(meta.createdAt);
      expect(got?.lastAccessedAt).toBe(meta.lastAccessedAt);
    } finally {
      await reg.shutdown();
    }
  });

  it("preserves identityId=null (anonymous sessions)", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      const meta = sample({ identityId: null });
      await reg.create(meta);
      const got = await reg.get(meta.sessionId);
      expect(got?.identityId).toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  it("delete removes the entry", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      const meta = sample();
      await reg.create(meta);
      await reg.delete(meta.sessionId);
      expect(await reg.get(meta.sessionId)).toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  it("delete is a no-op for an unknown session", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      await reg.delete("never-existed");
      // No throw — interface contract.
      expect(true).toBe(true);
    } finally {
      await reg.shutdown();
    }
  });

  it("touch is a no-op for an unknown session", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      await reg.touch("never-existed", Date.now());
      expect(await reg.get("never-existed")).toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  it("get evicts entries older than ttl", async () => {
    // Use a short TTL so the test doesn't race the wall clock.
    const reg = await factory({ ttlMs: 25, sweepIntervalMs: 5 });
    try {
      const meta = sample();
      await reg.create(meta);
      // Wait past TTL.
      await new Promise((r) => setTimeout(r, 40));
      expect(await reg.get(meta.sessionId)).toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  it("touch refreshes ttl so an actively-used session survives", async () => {
    // TTL=40ms; touch every 15ms; total elapsed > TTL but session must live.
    const reg = await factory({ ttlMs: 40, sweepIntervalMs: 5 });
    try {
      const meta = sample();
      await reg.create(meta);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 15));
        await reg.touch(meta.sessionId, Date.now());
      }
      const got = await reg.get(meta.sessionId);
      expect(got).not.toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  it("create is idempotent — re-create overwrites", async () => {
    const reg = await factory({ ttlMs: 60_000 });
    try {
      const sid = "re-init-test";
      await reg.create(sample({ sessionId: sid, workspaceId: "ws_a" }));
      await reg.create(sample({ sessionId: sid, workspaceId: "ws_b" }));
      const got = await reg.get(sid);
      expect(got?.workspaceId).toBe("ws_b");
    } finally {
      await reg.shutdown();
    }
  });
}
