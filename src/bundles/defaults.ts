import type {
  BundleRef,
  BundleUiMeta,
  HostManifestMeta,
  LocalBundleMeta,
  PlacementDeclaration,
} from "./types.ts";

/** Max length for untrusted display strings on a placement (label/icon). */
const PLACEMENT_STRING_MAX = 128;

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
 * Validate + sanitize server-declared placements. A server's declared chrome is
 * untrusted input even when sourced from the operator catalog, so this runs at
 * EVERY registration site — both the install handlers (`registerPlacements`) and
 * the boot path (`runtime.ts`), so a spoof can't slip in on restart. Fail-closed
 * per-placement: an invalid one is dropped, the rest survive, a fully bad set
 * yields none (the connector still works tools-only).
 *
 * Rules:
 *  - `resourceUri` MUST be a well-formed `ui://<authority>/<path>` — rejects other
 *    schemes (no pointing host chrome at http/file/etc.), empty authority/path,
 *    and path traversal.
 *  - all placements MUST share ONE `ui://` authority — a server declares only its
 *    own UI namespace, never a second app's (anti-spoofing). First valid authority
 *    wins; placements referencing a different one are dropped.
 *  - `slot` MUST be a non-empty string (unknown slots pass — the shell drops slots
 *    it doesn't render; not fatal here).
 *  - `label`/`icon` are bounded; overlong values are truncated, not fatal.
 */
export function sanitizePlacements(
  placements: PlacementDeclaration[] | undefined,
): PlacementDeclaration[] {
  if (!placements || placements.length === 0) return [];
  let authority: string | null = null;
  const out: PlacementDeclaration[] = [];
  for (const p of placements) {
    if (!p || typeof p.slot !== "string" || p.slot.trim() === "") continue;
    if (typeof p.resourceUri !== "string") continue;
    const m = /^ui:\/\/([^/]+)\/(.+)$/.exec(p.resourceUri);
    if (!m) continue;
    const [, auth, path] = m;
    if (!auth || !path || path.includes("..")) continue;
    if (authority === null) authority = auth;
    else if (auth !== authority) continue; // anti-spoof: one server, one ui authority
    const safe: PlacementDeclaration = { slot: p.slot, resourceUri: p.resourceUri };
    if (typeof p.priority === "number") safe.priority = p.priority;
    if (typeof p.label === "string") safe.label = p.label.slice(0, PLACEMENT_STRING_MAX);
    if (typeof p.icon === "string") safe.icon = p.icon.slice(0, PLACEMENT_STRING_MAX);
    if (typeof p.route === "string") safe.route = p.route;
    if (p.size === "compact" || p.size === "full" || p.size === "auto") safe.size = p.size;
    out.push(safe);
  }
  return out;
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
