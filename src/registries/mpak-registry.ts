import type { ConnectorRegistry, DirectoryEntry, RegistryConfig } from "./types.ts";

/**
 * Surfaces mpak.dev bundles in the connector directory.
 *
 * v1: stub. Returns a small hand-curated set of well-known mpak
 * bundles (echo, ipinfo, brave-search, etc.) so the unified-shape
 * Browse rendering works end-to-end. The real implementation will
 * fetch from mpak.dev's search API and populate live results.
 *
 * TODO(mpak-integration):
 *   1. Fetch GET ${url}/api/v1/bundles?page_size=100 (or equivalent)
 *   2. Map each result to a DirectoryEntry with kind="mpak-bundle"
 *   3. Cache results with a sensible TTL (5 min?) — Browse is hit
 *      every time the page loads.
 *   4. Wire the install path: lifecycle.install needs a "fetch from
 *      mpak" code path that downloads the bundle, validates, and
 *      registers it in workspace.json.
 *
 * Until the full integration lands, the Install button on
 * mpak-bundle entries is rendered disabled with a "Coming soon"
 * affordance pointing at mpak.dev.
 */
export class MpakRegistry implements ConnectorRegistry {
  constructor(public readonly config: RegistryConfig) {}

  async listEntries(): Promise<DirectoryEntry[]> {
    // Returns nothing until real mpak.dev fetch is wired up. The
    // hardcoded sample set this used to expose has been retired —
    // every connector it advertised (echo, ipinfo, brave-search,
    // finnhub, granola) is now surfaced by CuratedRegistry, either
    // as a stdio bundle (STDIO_BUNDLES) or a remote-OAuth catalog
    // entry. Keeping the stubs around caused two real bugs:
    //
    //   1. Duplicate Browse cards for connectors in both lists.
    //      The cross-registry dedup catches identical install
    //      targets (mpak-bundle for both registries), but granola
    //      appears as remote-oauth in curated and mpak-bundle here,
    //      so the dedup keys don't match — both rows survive.
    //
    //   2. Broken installs. Clicking the mpak card sends a catalogId
    //      shaped like `@nimblebraininc/<name>`, which routes through
    //      handleInstall. The OAuth catalog uses short ids; the
    //      curated stdio catalog excludes anything also in the OAuth
    //      catalog (granola). Result: "Catalog entry not found."
    //
    // Returning [] is the conservative answer until mpak.dev's
    // search/registry API is plumbed through. The install path
    // stays forward-compatible: handleInstall accepts any scoped
    // package name, so once real entries flow through here they'll
    // install correctly on day one.
    return [];
  }
}
