import type {
  BundleRef,
  BundleUiMeta,
  HostManifestMeta,
  LocalBundleMeta,
  PlacementDeclaration,
} from "./types.ts";

/** Max length for a bundle-authored display string (host `name`/`icon`, placement `label`/`icon`). */
const DISPLAY_STRING_MAX = 128;

/**
 * Connectors included by default. Empty: platform capabilities
 * (conversations, files, home, settings, usage, automations) are in-process
 * MCP servers — see src/tools/platform/.
 */
export const DEFAULT_BUNDLES: BundleRef[] = [];

/** Merge default connectors with user-configured ones, deduplicating by URL. */
export function mergeBundles(userBundles: BundleRef[], noDefaults?: boolean): BundleRef[] {
  const defaults = noDefaults ? [] : DEFAULT_BUNDLES;
  const userUrls = new Set(userBundles.map((b) => b.url));
  return [...defaults.filter((b) => !userUrls.has(b.url)), ...userBundles];
}

/**
 * Map a host `_meta["ai.nimblebrain/host"]` block to the runtime's `BundleUiMeta`.
 * The single source of truth for this projection — used by every install path
 * (the curated catalog and the fleet-connector `ServerDetail._meta`), so
 * "an MCP server is an MCP server" holds at the `_meta` interface. Returns
 * null unless a `name` is present (the host needs a label to surface anything).
 */
export function hostMetaToUiMeta(hostMeta: HostManifestMeta | undefined): BundleUiMeta | null {
  // `hostMeta` is an unchecked cast over registry JSON (`getNimbleBrainHostMeta`),
  // so every field here is `unknown` in practice and only the schema-gated
  // install path has validated it. Type-check before touching, exactly as
  // `sanitizePlacementFields` does below — a truthy non-string `name` would
  // otherwise throw out of catalog projection and take the whole catalog with it.
  if (typeof hostMeta?.name !== "string" || hostMeta.name === "") return null;
  const ui: BundleUiMeta = {
    name: hostMeta.name.slice(0, DISPLAY_STRING_MAX),
    icon: typeof hostMeta.icon === "string" ? hostMeta.icon.slice(0, DISPLAY_STRING_MAX) : "",
  };
  if (Array.isArray(hostMeta.placements) && hostMeta.placements.length > 0) {
    ui.placements = hostMeta.placements;
  }
  return ui;
}

/** Validate a placement's slot and `ui://` resourceUri; return its authority, or null if malformed. */
function placementAuthority(p: PlacementDeclaration): string | null {
  if (!p || typeof p.slot !== "string" || p.slot.trim() === "") return null;
  if (typeof p.resourceUri !== "string") return null;
  const m = /^ui:\/\/([^/]+)\/(.+)$/.exec(p.resourceUri);
  if (!m) return null;
  const [, auth, path] = m;
  if (!auth || !path || path.includes("..")) return null;
  return auth;
}

/** Copy a validated placement's fields into a fresh object, bounding label/icon and gating optional fields. */
function sanitizePlacementFields(p: PlacementDeclaration): PlacementDeclaration {
  const safe: PlacementDeclaration = { slot: p.slot, resourceUri: p.resourceUri };
  if (typeof p.priority === "number") safe.priority = p.priority;
  if (typeof p.label === "string") safe.label = p.label.slice(0, DISPLAY_STRING_MAX);
  if (typeof p.icon === "string") safe.icon = p.icon.slice(0, DISPLAY_STRING_MAX);
  if (typeof p.route === "string") safe.route = p.route;
  if (p.size === "compact" || p.size === "full" || p.size === "auto") safe.size = p.size;
  return safe;
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
 *  - all placements MUST share ONE `ui://` authority (internal consistency): the
 *    first valid authority wins, others are dropped. This is NOT a binding to the
 *    server's identity — the function has no server name here, and the `ui://`
 *    authority (e.g. `people`) differs from the slugified server id
 *    (`ai-nimblebrain-people-mcp`) anyway, so they can't be equality-checked. It
 *    only stops a single declaration from MIXING authorities; it does NOT stop a
 *    connector from declaring a *sole* foreign authority (e.g. `ui://home/...`).
 *    That is not a host-surface takeover: rendering resolves a placement's
 *    resource from its OWN `serverName` (SlotRenderer → `getResources(serverName,
 *    …)`, serverName-scoped iframe), so a connector only ever renders its own
 *    content. Residual is cosmetic (a granted connector could occupy a slot with
 *    an arbitrary label, rendering its own content). (Order-dependent: a junk
 *    authority listed first drops the legit ones — harmless for the same reason.)
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
    const auth = placementAuthority(p);
    if (auth === null) continue;
    if (authority === null) authority = auth;
    else if (auth !== authority) continue; // internal consistency: one authority per declaration
    out.push(sanitizePlacementFields(p));
  }
  return out;
}

/**
 * Map a `ServerDetail`-shaped record's `_meta["ai.nimblebrain/host"]` block
 * onto the runtime's `LocalBundleMeta`.
 */
export function extractBundleMeta(detail: Record<string, unknown>): LocalBundleMeta {
  const meta = detail._meta as Record<string, unknown> | undefined;
  const hostMeta = meta?.["ai.nimblebrain/host"] as HostManifestMeta | undefined;
  return {
    manifestName: detail.name as string | undefined,
    version: (detail.version as string) ?? "unknown",
    description: detail.description as string | undefined,
    ui: hostMetaToUiMeta(hostMeta),
    briefing: hostMeta?.briefing ?? null,
  };
}
