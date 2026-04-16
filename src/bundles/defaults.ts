import type { BundleRef, BundleUiMeta, HostManifestMeta, LocalBundleMeta } from "./types.ts";

/**
 * Bundles included by default as MCP processes.
 * Platform capabilities (conversations, files, home, settings, usage, automations)
 * are now inline InlineSources — see src/tools/platform/.
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
  };
}
