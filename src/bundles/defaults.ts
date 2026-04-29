import type {
  BundleRef,
  BundleUiMeta,
  HostManifestMeta,
  HttpProxyConfig,
  LocalBundleMeta,
} from "./types.ts";

/** Path segments reserved for platform-managed routes under /v1/apps/<bundle>/. */
const RESERVED_PROXY_MOUNTS = new Set(["resources", "tools", "mcp", "events"]);

/** Hostnames that resolve to the bundle's own loopback interface. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * Bundles included by default as MCP subprocesses.
 * Platform capabilities (conversations, files, home, settings, usage, automations)
 * are in-process MCP servers — see src/tools/platform/.
 */
export const DEFAULT_BUNDLES: BundleRef[] = [];

/** Merge default bundles with user-configured bundles, deduplicating. */
export function mergeBundles(userBundles: BundleRef[], noDefaults?: boolean): BundleRef[] {
  const defaults = noDefaults ? [] : DEFAULT_BUNDLES;
  const userNames = new Set(
    userBundles.filter((b): b is BundleRef & { name: string } => "name" in b).map((b) => b.name),
  );
  const userPaths = new Set(
    userBundles.filter((b): b is BundleRef & { path: string } => "path" in b).map((b) => b.path),
  );
  const mergedDefaults = defaults.filter((b) => {
    if ("name" in b) return !userNames.has(b.name);
    if ("path" in b) return !userPaths.has(b.path);
    return true;
  });
  return [...mergedDefaults, ...userBundles];
}

/**
 * Extract LocalBundleMeta from a raw manifest object.
 * Used by both the mpak and local bundle startup paths.
 */
export function extractBundleMeta(manifest: Record<string, unknown>): LocalBundleMeta {
  const meta = manifest._meta as Record<string, unknown> | undefined;
  const hostMeta = meta?.["ai.nimblebrain/host"] as HostManifestMeta | undefined;
  const ui: BundleUiMeta | null = hostMeta?.name
    ? { name: hostMeta.name, icon: hostMeta.icon ?? "", placements: hostMeta.placements }
    : null;
  const upjackMeta = meta?.["ai.nimblebrain/upjack"] as { namespace?: string } | undefined;
  const isUpjack = upjackMeta != null;
  return {
    manifestName: manifest.name as string | undefined,
    version: (manifest.version as string) ?? "unknown",
    description: manifest.description as string | undefined,
    ui,
    briefing: hostMeta?.briefing ?? null,
    type: isUpjack ? "upjack" : "plain",
    upjackNamespace: upjackMeta?.namespace,
    httpProxy: extractHttpProxy(meta),
  };
}

/**
 * Parse and validate `_meta["ai.nimblebrain/http-proxy"]`.
 *
 * Targets are restricted to loopback hosts. The proxy primitive exists so a
 * bundle can expose its OWN local HTTP server (an `astro dev` it spawned, a
 * Jupyter kernel, etc.) — there is no legitimate reason for a target to point
 * at any other host. Allowing arbitrary hosts would turn the proxy into an
 * SSRF gadget capable of reaching cloud metadata services (169.254.169.254),
 * internal/RFC1918 networks, or arbitrary external hosts, with the
 * authenticated user's credentials attached.
 */
function extractHttpProxy(meta: Record<string, unknown> | undefined): HttpProxyConfig | null {
  const raw = meta?.["ai.nimblebrain/http-proxy"];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const target = typeof r.target === "string" ? r.target : undefined;
  const mount = typeof r.mount === "string" ? r.mount : undefined;
  if (!target || !mount) {
    console.warn("[bundles] http-proxy declaration missing target or mount — ignoring");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    console.warn(`[bundles] http-proxy target is not a valid URL — got ${target}, ignoring`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(`[bundles] http-proxy target must be http(s):// — got ${target}, ignoring`);
    return null;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    console.warn(
      `[bundles] http-proxy target must point to a loopback host (127.0.0.1, ::1, or localhost) — got ${parsed.hostname}, ignoring`,
    );
    return null;
  }
  const normalizedMount = mount.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedMount || normalizedMount.includes("/")) {
    console.warn(
      `[bundles] http-proxy mount must be a single path segment (no slashes) — got ${mount}, ignoring`,
    );
    return null;
  }
  if (RESERVED_PROXY_MOUNTS.has(normalizedMount)) {
    console.warn(`[bundles] http-proxy mount "${normalizedMount}" is reserved — ignoring`);
    return null;
  }
  return {
    target,
    mount: normalizedMount,
    websocket: r.websocket === true,
  };
}
