import { MpakClient } from "@nimblebrain/mpak-sdk";
import { log } from "../cli/log.ts";
import { type ServerDetail, validateServerDetail } from "../connectors/server-detail.ts";
import { projectServerDetailToDirectoryEntry } from "./projection.ts";
import type { ConnectorRegistry, DirectoryEntry, RegistryConfig } from "./types.ts";

/**
 * Surfaces mpak bundles in the connector directory.
 *
 * Calls mpak's `/v1/servers/search` (the MCP-spec-aligned endpoint
 * shipped with mpak SDK 0.8) and gets back native `ServerDetail[]`.
 * The platform validates each entry against its local ajv schema and
 * projects to `DirectoryEntry` via the same shared projection every
 * registry uses. No client-side composition — mpak's server-side
 * composer owns the canonical wire format.
 *
 * Failure modes are graceful: a network error or HTTP 4xx/5xx throws
 * to the aggregator so the per-registry error list shows a degraded
 * mpak rather than a silent zero-results state hiding the failure.
 *
 * Results are cached at module scope keyed by base URL with a 5-minute
 * TTL so the Browse page and the installed-connector list (which uses
 * the cache via {@link loadMpakServers} to resolve stdio-bundle icons)
 * share one fetch. Errors are not cached — a down registry retries on
 * the next call.
 */
export class MpakRegistry implements ConnectorRegistry {
  constructor(public readonly config: RegistryConfig) {}

  async listEntries(): Promise<DirectoryEntry[]> {
    const servers = await fetchServers(this.config.url);
    const out: DirectoryEntry[] = [];
    for (const s of servers) {
      const entry = projectServerDetailToDirectoryEntry(s, {
        registryId: this.config.id,
        registryType: this.config.type,
      });
      if (entry) out.push(entry);
    }
    return out;
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

/**
 * Fetch + validate `ServerDetail[]` for an mpak instance.
 * `baseUrl === undefined` means "use the SDK's built-in default" —
 * the platform doesn't store or duplicate that constant. Returns the
 * cached list when fresh; otherwise calls `/v1/servers/search` via
 * the SDK and populates the cache on success. Errors propagate (no
 * negative caching — an outage retries on the next call rather than
 * masking the live state for 5 minutes).
 *
 * Exported so {@link loadMpakConnectorIcons}-style consumers can read
 * the same canonical list the registry projection sees, without
 * paying for a second HTTP round-trip.
 */
export async function loadMpakServers(baseUrl: string | undefined): Promise<ServerDetail[]> {
  return fetchServers(baseUrl);
}

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
        `[mpak-registry] entry "${name}" dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      );
      continue;
    }
    valid.push(c as ServerDetail);
  }
  cache.set(cacheKey, { servers: valid, expiresAt: now + CACHE_TTL_MS });
  return valid;
}

/** Drop every cached entry. Test helper — production callers rely on TTL expiry. */
export function _resetMpakRegistryCache(): void {
  cache.clear();
}
