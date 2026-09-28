/**
 * The `ai.nimblebrain/facets` MCP extension, host side.
 *
 * A server that advertises the extension in its capabilities lists each facet
 * as a resource carrying `_meta["ai.nimblebrain/facets"]`, and answers
 * `resources/read` on it with `{ "count": n }`. The extension adds no method.
 * Public contract: `docs/src/content/docs/apps/facets.mdx`.
 *
 * This module holds the wire shape and the checks the extension requires of a
 * host. It does no I/O; the briefing collector lists, reads, and caches.
 */

/** Extension identifier, the key in `capabilities.extensions` and in a facet resource's `_meta`. */
export const FACETS_EXTENSION_ID = "ai.nimblebrain/facets" as const;

/**
 * The client's declaration: the extension with an empty settings object, so a
 * server may skip listing facets to a host that will not read them.
 */
export function facetsClientExtension(): Record<string, Record<string, never>> {
  return { [FACETS_EXTENSION_ID]: {} };
}

/** One facet a server listed: what the host reads and what it renders beside the count. */
export interface DiscoveredFacet {
  uri: string;
  /** Stable within the server; with the server's identity, the cache key. */
  name: string;
  /** The label, rendered as `<count> <title>`. */
  title: string;
}

/** A listed resource that carries the marker but breaks the contract, with why. */
export interface RejectedFacet {
  uri: string;
  reason: string;
}

/**
 * Keep the entries of a `resources/list` result that carry the facet marker.
 *
 * The marker is the only signal: never the URI's scheme or shape, never the
 * name, never the MIME type alone. A marked entry without a `title`, or whose
 * `mimeType` is not `application/json`, is rejected rather than guessed at.
 * The caller must have checked that the server advertised the extension; a
 * marker from a server that did not is not a facet.
 */
export function selectFacets(resources: readonly unknown[]): {
  facets: DiscoveredFacet[];
  rejected: RejectedFacet[];
} {
  const facets: DiscoveredFacet[] = [];
  const rejected: RejectedFacet[] = [];
  for (const raw of resources) {
    if (!isRecord(raw) || !isMarked(raw)) continue;
    const checked = checkFacetEntry(raw);
    if ("reason" in checked) rejected.push(checked);
    else facets.push(checked);
  }
  return { facets, rejected };
}

function isMarked(entry: Record<string, unknown>): boolean {
  const meta = entry._meta;
  return isRecord(meta) && isRecord(meta[FACETS_EXTENSION_ID]);
}

/** A marked entry as a facet, or why it is not one. */
function checkFacetEntry(entry: Record<string, unknown>): DiscoveredFacet | RejectedFacet {
  const uri = typeof entry.uri === "string" ? entry.uri : "";
  const { name, title } = entry;
  if (!uri || typeof name !== "string" || name === "") {
    return { uri, reason: "missing uri or name" };
  }
  if (entry.mimeType !== "application/json") {
    return { uri, reason: "mimeType is not application/json" };
  }
  if (typeof title !== "string" || title.trim() === "") {
    return { uri, reason: "missing title" };
  }
  return { uri, name, title };
}

/**
 * Parse a facet read: the first text content, as a JSON object whose `count`
 * is an integer ≥ 0. Anything else is a failed read, with a reason for the log.
 * Fields other than `count` are ignored.
 */
export function parseFacetCount(
  data: { text?: string } | null,
): { ok: true; count: number } | { ok: false; reason: string } {
  if (!data) return { ok: false, reason: "empty or failed read" };
  if (typeof data.text !== "string") return { ok: false, reason: "no text content" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.text);
  } catch {
    return { ok: false, reason: "text is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not a JSON object" };
  const count = parsed.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { ok: false, reason: "count is not a non-negative integer" };
  }
  return { ok: true, count };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
