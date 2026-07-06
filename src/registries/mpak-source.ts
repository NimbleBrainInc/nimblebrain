import { MpakClient } from "@nimblebrain/mpak-sdk";
import { type ServerDetail, validateServerDetail } from "../connectors/server-detail.ts";
import { log } from "../observability/log.ts";
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
/**
 * Hard ceiling on pagination loops — protects against an upstream bug
 * (cursor never goes empty) turning Browse into an infinite fetch.
 * Sized for ~10 × `PAGE_LIMIT` = 1000 entries, well past the catalog's
 * realistic size today; if a registry legitimately exceeds this we
 * want the warning + truncation, not an unbounded loop.
 */
const MAX_PAGES = 10;
/** Cache key sentinel for the SDK-default base URL (no operator override). */
const DEFAULT_KEY = "<sdk-default>";

interface CacheEntry {
  servers: ServerDetail[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** One page of the search response: raw entries plus the cursor to the next page. */
interface SearchPage {
  servers?: unknown[];
  metadata?: { next_cursor?: string };
}

/** Build an mpak SDK client, honoring an operator base-URL override when present. */
function createClient(baseUrl: string | undefined): MpakClient {
  return new MpakClient({
    timeout: REQUEST_TIMEOUT_MS,
    ...(baseUrl ? { registryUrl: baseUrl } : {}),
  });
}

/** Fetch one page of servers, wrapping any SDK failure in a registry-fetch error. */
async function searchPage(client: MpakClient, cursor: string | undefined): Promise<SearchPage> {
  try {
    return (await client.searchServers({
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    })) as SearchPage;
  } catch (err) {
    throw new Error(
      `mpak registry fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Best-effort display name for an entry that failed validation. */
function entryName(c: unknown): string {
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    return (c as { name: string }).name;
  }
  return "<unnamed>";
}

/** Validate raw entries in order, pushing valid ServerDetails and logging drops. */
function collectValid(candidates: unknown[], valid: ServerDetail[]): void {
  for (const c of candidates) {
    const result = validateServerDetail(c);
    if (!result.valid) {
      log.warn(
        `[mpak-source] entry "${entryName(c)}" dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      );
      continue;
    }
    valid.push(c as ServerDetail);
  }
}

/**
 * Log the pagination-ceiling warning, naming the registry so an operator
 * looking at logs can correlate which one got truncated — a deployment
 * with multiple mpak rows (different scopes, self-hosted vs public, etc.)
 * can't tell from a generic message alone.
 */
function warnPageCeiling(baseUrl: string | undefined): void {
  const where = baseUrl ?? "<sdk-default>";
  log.warn(
    `[mpak-source] page ceiling hit for ${where} (${MAX_PAGES} × ${PAGE_LIMIT} = ${MAX_PAGES * PAGE_LIMIT} entries); remaining results truncated. Raise MAX_PAGES if this is a legitimate large registry.`,
  );
}

async function fetchServers(baseUrl: string | undefined): Promise<ServerDetail[]> {
  const now = Date.now();
  const cacheKey = baseUrl ?? DEFAULT_KEY;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.servers;

  const client = createClient(baseUrl);

  // Paginate via `metadata.next_cursor` (per ServerListResponseSchema in
  // @nimblebrain/mpak-schemas). A single-page fetch would silently
  // truncate at PAGE_LIMIT — that compounds with the directory's
  // post-fetch scope filter, so a `scopes: ["nimblebraininc"]` config
  // could see *zero* matches if the first page happened to be all
  // non-`nimblebraininc` entries. Loop until the registry signals "no
  // more" (cursor absent), with MAX_PAGES as a safety ceiling against
  // upstream-bug infinite loops.
  const valid: ServerDetail[] = [];
  let cursor: string | undefined;
  let pages = 0;
  while (true) {
    pages++;
    const response = await searchPage(client, cursor);
    const candidates = Array.isArray(response.servers) ? response.servers : [];
    collectValid(candidates, valid);

    cursor = response.metadata?.next_cursor;
    if (!cursor) break;
    if (pages >= MAX_PAGES) {
      warnPageCeiling(baseUrl);
      break;
    }
  }
  cache.set(cacheKey, { servers: valid, expiresAt: now + CACHE_TTL_MS });
  return valid;
}

/** Drop every cached entry. Test helper — production callers rely on TTL expiry. */
export function _resetMpakSourceCache(): void {
  cache.clear();
}
