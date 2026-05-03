import { afterEach, describe, expect, it } from "bun:test";
import { resolveSessionStoreConfig } from "../../../../src/api/session-store/factory.ts";

describe("resolveSessionStoreConfig", () => {
  it("returns memory + 8h TTL (in ms) when input is undefined", () => {
    const r = resolveSessionStoreConfig(undefined);
    expect(r.type).toBe("memory");
    expect(r.ttlMs).toBe(8 * 60 * 60 * 1000);
  });

  // Operator-facing knob is `ttlSeconds`; resolver multiplies once for the
  // internal currency. Sanity-checking the conversion here, not in every test.
  it("converts ttlSeconds → ttlMs at the resolver boundary", () => {
    const r = resolveSessionStoreConfig({ ttlSeconds: 60 });
    expect(r.type).toBe("memory");
    expect(r.ttlMs).toBe(60_000);
  });

  it("returns memory when type='memory' is explicit", () => {
    const r = resolveSessionStoreConfig({ type: "memory", ttlSeconds: 1 });
    expect(r.type).toBe("memory");
    expect(r.ttlMs).toBe(1000);
  });

  // Production-safety: silently falling back to in-memory when redis is
  // requested but unconfigured would let a multi-replica deploy ship with a
  // broken session store. Fail loud at boot.
  it("throws when type='redis' and url is missing", () => {
    expect(() => resolveSessionStoreConfig({ type: "redis" })).toThrow(
      /requires sessionStore.redis.url/,
    );
  });

  it("throws when type='redis' and url is whitespace", () => {
    expect(() =>
      resolveSessionStoreConfig({ type: "redis", redis: { url: "   " } }),
    ).toThrow(/requires sessionStore.redis.url/);
  });

  it("returns redis with defaults applied when url is provided", () => {
    const r = resolveSessionStoreConfig({
      type: "redis",
      redis: { url: "redis://example:6379" },
    });
    expect(r.type).toBe("redis");
    if (r.type !== "redis") return;
    expect(r.redis.url).toBe("redis://example:6379");
    expect(r.redis.keyPrefix).toBe("nb:mcp:session:");
    expect(r.ttlMs).toBe(8 * 60 * 60 * 1000);
  });

  it("honors explicit keyPrefix and ttlSeconds overrides", () => {
    const r = resolveSessionStoreConfig({
      type: "redis",
      ttlSeconds: 1800,
      redis: { url: "redis://example", keyPrefix: "custom:" },
    });
    if (r.type !== "redis") throw new Error("expected redis");
    expect(r.ttlMs).toBe(1_800_000);
    expect(r.redis.keyPrefix).toBe("custom:");
  });

  // Helm-driven deployment pattern: configmap renders a literal "${REDIS_URL}"
  // placeholder; the actual URL flies in from an envFrom-mounted secret at
  // process start. The factory must expand it before handing to RedisClient.
  describe("env-var expansion in redis.url", () => {
    const ENV = "__TEST_REDIS_URL__";

    afterEach(() => {
      delete process.env[ENV];
    });

    it("expands ${VAR} from process.env", () => {
      process.env[ENV] = "redis://prod-cluster:6379";
      const r = resolveSessionStoreConfig({
        type: "redis",
        redis: { url: `\${${ENV}}` },
      });
      if (r.type !== "redis") throw new Error("expected redis");
      expect(r.redis.url).toBe("redis://prod-cluster:6379");
    });

    it("throws when ${VAR} expands to empty (undefined env)", () => {
      // ENV deliberately unset.
      expect(() =>
        resolveSessionStoreConfig({
          type: "redis",
          redis: { url: `\${${ENV}}` },
        }),
      ).toThrow(/requires sessionStore.redis.url/);
    });

    it("leaves literal URLs untouched (no false-positive matches)", () => {
      const literal = "redis://user:pass@host:6379/0";
      const r = resolveSessionStoreConfig({
        type: "redis",
        redis: { url: literal },
      });
      if (r.type !== "redis") throw new Error("expected redis");
      expect(r.redis.url).toBe(literal);
    });
  });
});
