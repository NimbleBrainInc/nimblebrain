/**
 * Build a SessionRegistry from validated config. The single place that
 * knows about all provider implementations — keeps `mcp-server.ts` and
 * `server.ts` provider-agnostic.
 */

import { log } from "../../observability/log.ts";
import { InMemorySessionRegistry } from "./memory.ts";
import { RedisSessionRegistry } from "./redis.ts";
import type { SessionRegistry } from "./types.ts";

/**
 * Resolved (post-defaults) session-store configuration.
 *
 * Operator-facing config (in `nimblebrain.json`) uses `ttlSeconds` because
 * milliseconds are implementation-leakage — nobody sets a sub-second
 * session timeout. The Resolved shape, however, carries `ttlMs` because
 * that's the unit the providers consume (`Date.now()` is ms, sweep math
 * is ms, `PEXPIRE` takes ms). The conversion happens once in
 * `resolveSessionStoreConfig` so the rest of the runtime never has to
 * think about units.
 */
export type ResolvedSessionStoreConfig =
  | {
      type: "memory";
      ttlMs: number;
    }
  | {
      type: "redis";
      ttlMs: number;
      redis: {
        url: string;
        keyPrefix: string;
      };
    };

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

/**
 * Apply defaults to a partial session-store config and convert the
 * operator-facing `ttlSeconds` to the internal `ttlMs` currency.
 *
 * - No config at all → in-memory, 8h TTL.
 * - `type: "redis"` with no URL → throws; we won't silently fall back to
 *   in-memory for production deploys, that would mask misconfiguration.
 */
export function resolveSessionStoreConfig(
  raw: PartialSessionStoreConfig | undefined,
): ResolvedSessionStoreConfig {
  const ttlSeconds = raw?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const ttlMs = ttlSeconds * 1000;

  if (!raw || raw.type === undefined || raw.type === "memory") {
    return { type: "memory", ttlMs };
  }
  if (raw.type === "redis") {
    // ${VAR} expansion lets a Helm-rendered configmap carry a placeholder
    // (`"url": "${REDIS_URL}"`) and have the URL fly in from an envFrom-
    // mounted secret at process start. The expanded value is what the
    // factory hands to `Bun.RedisClient`. We expand only this one field
    // because the rest of `nimblebrain.json` is operator-controlled,
    // non-secret, and shouldn't leak env into arbitrary config strings.
    const url = expandEnvVars(raw.redis?.url ?? "").trim();
    if (!url) {
      throw new Error(
        'sessionStore.type="redis" requires sessionStore.redis.url. ' +
          "Set REDIS_URL (or the env var named in sessionStore.redis.url) in " +
          "the deployment environment, or change type to 'memory'.",
      );
    }
    return {
      type: "redis",
      ttlMs,
      redis: {
        url,
        keyPrefix: raw.redis?.keyPrefix ?? "nb:mcp:session:",
      },
    };
  }
  // Exhaustiveness — TS will catch unhandled types if the union grows.
  const _exhaustive: never = raw.type;
  throw new Error(`Unknown sessionStore.type: ${String(_exhaustive)}`);
}

/** Loose, user-facing shape (every field optional). */
export interface PartialSessionStoreConfig {
  type?: "memory" | "redis";
  /**
   * Idle TTL in seconds. Sessions older than this on `lastAccessedAt` are
   * evicted on the next sweep / TTL fire. Default: 28800 (8 h).
   */
  ttlSeconds?: number;
  redis?: {
    url?: string;
    keyPrefix?: string;
  };
}

/**
 * Build the registry. For Redis, connects up front so misconfiguration
 * fails the boot instead of every individual MCP request.
 */
export async function createSessionRegistry(
  cfg: ResolvedSessionStoreConfig,
): Promise<SessionRegistry> {
  // Log lines surface seconds — the unit operators set in config — even
  // though the providers themselves run on ms internally.
  const ttlSec = cfg.ttlMs / 1000;
  switch (cfg.type) {
    case "memory":
      log.info(`[mcp] session store: memory ttl=${ttlSec}s`);
      return new InMemorySessionRegistry({ ttlMs: cfg.ttlMs });
    case "redis": {
      log.info(
        `[mcp] session store: redis url=${redactUrl(cfg.redis.url)} ttl=${ttlSec}s keyPrefix=${cfg.redis.keyPrefix}`,
      );
      const registry = new RedisSessionRegistry({
        url: cfg.redis.url,
        ttlMs: cfg.ttlMs,
        keyPrefix: cfg.redis.keyPrefix,
      });
      await registry.connect();
      return registry;
    }
  }
}

/**
 * Replace `${VAR}` placeholders in a string with `process.env[VAR]`. An
 * undefined env var expands to empty (the trim+empty-check upstream then
 * surfaces the misconfiguration as a thrown error, not a malformed URL).
 *
 * Names must match `[A-Z_][A-Z0-9_]*` — the standard K8s / shell convention.
 * Lowercase placeholders like `${redis_url}` deliberately don't expand and
 * will pass through into the URL, where the Redis client will reject them.
 * If that surprises a caller, fix the env-var name to be uppercase rather
 * than weakening this regex.
 */
function expandEnvVars(input: string): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    return process.env[name] ?? "";
  });
}

/**
 * Hide credentials in logged Redis URLs. `redis://user:pass@host:6379` →
 * `redis://***@host:6379`.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}
