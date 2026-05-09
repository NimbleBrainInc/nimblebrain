import { log } from "../cli/log.ts";
import { type ServerDetail, validateServerDetail } from "../connectors/server-detail.ts";
import { projectServerDetailToDirectoryEntry } from "./projection.ts";
import type { ConnectorRegistry, DirectoryEntry, RegistryConfig } from "./types.ts";

/**
 * Surfaces mpak bundles in the connector directory.
 *
 * Adapter mode (today): the registry's HTTP API still returns mpak's
 * legacy `/v1/bundles/...` shape (per-bundle JSON with `name`,
 * `display_name`, `description`, `latest_version`, `icon`, ...). This
 * class fetches that shape, projects each entry to upstream
 * `ServerDetail` using the same composition rules mpak will eventually
 * run server-side (per spec §2), validates the result against the
 * upstream schema, and projects to `DirectoryEntry`.
 *
 * Passthrough mode (future): once mpak ships `/v1/servers/...`
 * returning native `ServerDetail`, the only change here is dropping
 * `bundleToServerDetail` — the validation + projection-to-DirectoryEntry
 * stays.
 *
 * Failure modes are graceful: a network error or HTTP 4xx/5xx throws
 * to the aggregator so the per-registry error list shows a degraded
 * mpak rather than a silent zero-results state hiding the failure.
 */
export class MpakRegistry implements ConnectorRegistry {
  /** Hard cap on the per-page fetch; mpak's API tops out near this. */
  private static readonly PAGE_LIMIT = 100;
  /** Network call ceiling. The Browse page hangs while this resolves. */
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  constructor(public readonly config: RegistryConfig) {}

  async listEntries(): Promise<DirectoryEntry[]> {
    const baseUrl = this.config.url ?? "https://registry.mpak.dev";
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/bundles/search?limit=${MpakRegistry.PAGE_LIMIT}`;

    let payload: { bundles?: unknown[] };
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MpakRegistry.REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      payload = (await res.json()) as { bundles?: unknown[] };
    } catch (err) {
      throw new Error(
        `mpak registry fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const bundles = Array.isArray(payload.bundles) ? payload.bundles : [];
    const out: DirectoryEntry[] = [];
    for (const raw of bundles) {
      const detail = bundleToServerDetail(raw);
      if (!detail) continue;
      const validation = validateServerDetail(detail);
      if (!validation.valid) {
        log.warn(
          `[mpak-registry] entry "${detail.name}" dropped — invalid ServerDetail: ${validation.errors.join("; ")}`,
        );
        continue;
      }
      const entry = projectServerDetailToDirectoryEntry(detail, {
        registryId: this.config.id,
        registryType: this.config.type,
      });
      if (!entry) continue;
      out.push(entry);
    }
    return out;
  }
}

/** Shape of a single bundle in mpak's `/v1/bundles/search` response. */
interface MpakBundle {
  name: string;
  display_name?: string | null;
  description?: string | null;
  latest_version?: string | null;
  icon?: string | null;
  homepage?: string | null;
  downloads?: number;
  published_at?: string;
  certification_level?: number;
  provenance?: {
    schema_version?: number | string;
    provider?: string;
    repository?: string;
    sha?: string;
  };
}

/**
 * Project mpak's legacy bundle JSON to upstream `ServerDetail`.
 * Per spec §1.1 the reverse-DNS `name` is mechanically derived from
 * the npm-style scoped name when no author override is recorded.
 *
 * Returns null when the input doesn't carry the minimum fields the
 * upstream schema requires (name, description, version) — those are
 * registry-side bugs that shouldn't surface as broken cards.
 */
export function bundleToServerDetail(raw: unknown): ServerDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as MpakBundle;
  if (typeof b.name !== "string" || b.name.length === 0) return null;
  if (typeof b.description !== "string" || b.description.length === 0) return null;
  if (typeof b.latest_version !== "string" || b.latest_version.length === 0) return null;

  const reverseDnsName = mechanicalReverseDnsName(b.name);
  // Upstream schema constrains description to 1..100 chars. mpak today
  // has no length cap, so truncate at the boundary rather than dropping
  // an otherwise-valid entry. The full text remains in mpak.
  const description = truncate(b.description, 100);

  const detail: ServerDetail = {
    name: reverseDnsName,
    description,
    version: b.latest_version,
    title: b.display_name?.trim() || unscopedName(b.name),
    packages: [
      {
        registryType: "mpak",
        identifier: b.name,
        version: b.latest_version,
        transport: { type: "stdio" },
      },
    ],
  };

  if (b.icon) {
    detail.icons = [{ src: b.icon, sizes: ["any"] }];
  }
  if (b.provenance?.repository) {
    detail.repository = {
      url: `https://github.com/${b.provenance.repository}`,
      source: "github",
    };
  }
  if (b.homepage) {
    detail.websiteUrl = b.homepage;
  }

  // mpak-side enrichment carried under `dev.mpak/registry` per spec §2.
  // The current shape mirrors what mpak's server-side composer will
  // emit when it lands; consumers that key off these fields keep
  // working unchanged at swap time.
  const mpakMeta: Record<string, unknown> = {
    npmName: b.name,
  };
  if (typeof b.downloads === "number") mpakMeta.downloads = b.downloads;
  if (b.published_at) mpakMeta.published_at = b.published_at;
  if (typeof b.certification_level === "number") {
    mpakMeta.certification = { level: b.certification_level };
  }
  if (b.provenance) mpakMeta.provenance = b.provenance;
  detail._meta = { "dev.mpak/registry": mpakMeta };

  return detail;
}

/** Per spec §1.1: `@scope/name` → `dev.mpak.<lowercased-scope>/<unscoped-name>`. */
export function mechanicalReverseDnsName(npmName: string): string {
  const m = /^@([^/]+)\/(.+)$/.exec(npmName);
  if (!m) return `dev.mpak/${npmName.toLowerCase()}`;
  const scope = (m[1] ?? "").toLowerCase();
  const name = (m[2] ?? "").toLowerCase();
  return `dev.mpak.${scope}/${name}`;
}

function unscopedName(npmName: string): string {
  const m = /^@[^/]+\/(.+)$/.exec(npmName);
  return m?.[1] ?? npmName;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
