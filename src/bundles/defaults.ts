import type { BundleRef, BundleUiMeta, HostManifestMeta, LocalBundleMeta } from "./types.ts";

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
 * Map a host `_meta["ai.nimblebrain/host"]` block to the runtime's `BundleUiMeta`.
 * The single source of truth for this projection — used by every install path
 * (mpak manifest, local manifest, and the fleet-connector `ServerDetail._meta`),
 * so "an MCP server is an MCP server" holds at the `_meta` interface. Returns
 * null unless a `name` is present (the host needs a label to surface anything).
 */
export function hostMetaToUiMeta(hostMeta: HostManifestMeta | undefined): BundleUiMeta | null {
  if (!hostMeta?.name) return null;
  const ui: BundleUiMeta = { name: hostMeta.name, icon: hostMeta.icon ?? "" };
  if (hostMeta.placements && hostMeta.placements.length > 0) {
    ui.placements = hostMeta.placements;
  }
  return ui;
}

/**
 * Extract LocalBundleMeta from a raw manifest object.
 * Used by both the mpak and local bundle startup paths.
 */
export function extractBundleMeta(manifest: Record<string, unknown>): LocalBundleMeta {
  const meta = manifest._meta as Record<string, unknown> | undefined;
  const hostMeta = meta?.["ai.nimblebrain/host"] as HostManifestMeta | undefined;
  const ui = hostMetaToUiMeta(hostMeta);
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
  };
}
