import { MpakClient } from "@nimblebrain/mpak-sdk";
import { log } from "../cli/log.ts";
import { type ServerDetail, validateServerDetail } from "../connectors/server-detail.ts";
import type { ConnectorSource } from "./types.ts";

/**
 * Surfaces mpak bundles. Calls mpak's `/v1/servers/search` (the
 * MCP-spec-aligned endpoint shipped with mpak SDK 0.8) and gets back
 * native `ServerDetail[]`. Validates each entry against the local ajv
 * schema; the directory does projection, scope filtering, and error
 * aggregation on top.
 *
 * Caching is private: results live in a module-level map keyed by base
 * URL with a 5-minute TTL. The directory's read-side methods all flow
 * through the same `fetch()` so Browse and the installed-list lookups
 * share one HTTP round-trip. Errors are NOT cached — an outage retries
 * on the next call rather than masking the live state for 5 minutes.
 *
 * `baseUrl === undefined` means "use the SDK's built-in default" — the
 * platform doesn't store or duplicate that constant.
 */
export class MpakSource implements ConnectorSource {
  constructor(
    public readonly id: string,
    private readonly baseUrl: string | undefined,
  ) {}

  async fetch(): Promise<ServerDetail[]> {
    return fetchServers(this.baseUrl);
  }
}

const PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Cache key sentinel for the SDK-default base URL (no operator override). */
const DEFAULT_KEY = "<sdk-default>";

interface CacheEntry {
  servers: ServerDetail[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

async function fetchServers(baseUrl: string | undefined): Promise<ServerDetail[]> {
  const now = Date.now();
  const cacheKey = baseUrl ?? DEFAULT_KEY;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.servers;

  const client = new MpakClient({
    timeout: REQUEST_TIMEOUT_MS,
    ...(baseUrl ? { registryUrl: baseUrl } : {}),
  });
  let response: { servers?: unknown[] };
  try {
    response = (await client.searchServers({ limit: PAGE_LIMIT })) as {
      servers?: unknown[];
    };
  } catch (err) {
    throw new Error(
      `mpak registry fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const candidates = Array.isArray(response.servers) ? response.servers : [];
  const valid: ServerDetail[] = [];
  for (const c of candidates) {
    const result = validateServerDetail(c);
    if (!result.valid) {
      const name =
        c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"
          ? (c as { name: string }).name
          : "<unnamed>";
      log.warn(
        `[mpak-source] entry "${name}" dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      );
      continue;
    }
    valid.push(c as ServerDetail);
  }
  cache.set(cacheKey, { servers: valid, expiresAt: now + CACHE_TTL_MS });
  return valid;
}

/** Drop every cached entry. Test helper — production callers rely on TTL expiry. */
export function _resetMpakSourceCache(): void {
  cache.clear();
}
