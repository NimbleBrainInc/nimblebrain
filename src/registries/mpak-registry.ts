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
    const baseUrl = this.config.url ?? "https://mpak.dev";
    const samples: Array<{
      package: string;
      name: string;
      description: string;
      tags?: string[];
    }> = [
      {
        package: "@nimblebraininc/echo",
        name: "Echo",
        description: "Reference MCP server — echoes inputs for testing and demos.",
        tags: ["dev", "testing"],
      },
      {
        package: "@nimblebraininc/ipinfo",
        name: "IPInfo",
        description: "IP address geolocation and network metadata via ipinfo.io.",
        tags: ["network", "geolocation"],
      },
      {
        package: "@nimblebraininc/brave-search",
        name: "Brave Search",
        description: "Web search via Brave's independent index.",
        tags: ["search", "web"],
      },
      {
        package: "@nimblebraininc/finnhub",
        name: "Finnhub",
        description: "Real-time stock quotes, fundamentals, and market data.",
        tags: ["finance", "markets"],
      },
      {
        package: "@nimblebraininc/granola",
        name: "Granola Tools",
        description: "Local helper tools for the Granola desktop app.",
        tags: ["meetings", "productivity"],
      },
    ];

    return samples.map((s) => ({
      id: s.package,
      registryId: this.config.id,
      registryType: "mpak",
      name: s.name,
      description: s.description,
      iconUrl: `https://mpak.dev/icons/${encodeURIComponent(s.package)}.svg`,
      tags: s.tags,
      defaultScope: "workspace",
      install: {
        kind: "mpak-bundle",
        package: s.package,
        mpakUrl: `${baseUrl.replace(/\/$/, "")}/packages/${s.package}`,
      },
    }));
  }
}
