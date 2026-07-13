/**
 * Boot-time reconcile of connector-skill overlays to the currently-pinned
 * overlay version.
 *
 * Overlays otherwise bind only at connector *install* (`syncBoundSkills` in the
 * install path). The pinned version (`resolveConnectorSkillsConfig().version`)
 * is deploy-time config that only changes via a new platform image — i.e. a pod
 * restart. So a version bump never reaches connectors that are already installed:
 * their materialized overlay + `skillsLock` stay behind until the connector is
 * reinstalled. This reconcile closes that gap by running on boot — the one moment
 * the pin can have changed — and re-binding any connector whose lock is stale or
 * absent. Refresh becomes automatic on the very deploy that bumps the pin, with
 * no operator or agent action: the model has no business knowing overlays have
 * versions, exactly as it doesn't manage the tool-list memo's TTL.
 *
 * Safety:
 * - Version-gated: a connector already at the pinned version is skipped with no
 *   fetch and no write, so steady-state boots are near-free.
 * - Additive only: a fetch that returns nothing (no curated overlay, or a
 *   transient failure — `syncBoundSkills` is best-effort and can't distinguish
 *   them) leaves the connector *exactly as-is* and is retried next boot. The
 *   reconcile never clears a working overlay. Consequence: an overlay *removed*
 *   from the repo at the new pin does NOT propagate (its 404 is indistinguishable
 *   from a blip), so the connector keeps its stale overlay. Deprecating guidance
 *   means serving an empty/tombstone overlay at the new tag, not deleting the file.
 * - Non-fatal: every connector and every workspace is guarded; a failure is
 *   logged and skipped, never propagated to boot.
 *
 * Cost note: a connector with no curated overlay has no lock, so it never matches
 * the version gate and is re-checked every boot. That's a disk read, not a network
 * call — `resolveOverlay` writes a `{ miss: true }` sentinel to its PVC-backed
 * cache (keyed by identity@repo@version) on the first 404, so subsequent boots
 * short-circuit there. Network is hit once per (identity, version), ever.
 */

import { resolveConnectorSkillsConfig } from "../config/connector-skills.ts";
import { connectorSkillIdentityFrom } from "../connectors/server-detail.ts";
import { log } from "../observability/log.ts";
import type { ConnectorCatalogEntry } from "../registries/projection.ts";
import { serverNameFromRef } from "./paths.ts";
import type { BundleRef, ConnectorSkillLockEntry } from "./types.ts";

type ConnectorRef = Extract<BundleRef, { url: string }>;

export interface ConnectorSkillReconcileDeps {
  /** The overlay version every installed connector should track. */
  pinnedVersion: string;
  workDir: string;
  listWorkspaces: () => Promise<ReadonlyArray<{ id: string; bundles: BundleRef[] }>>;
  updateWorkspaceBundles: (wsId: string, bundles: BundleRef[]) => Promise<unknown>;
  syncBoundSkills: (
    identity: string,
    serverName: string,
    wsId: string,
    workDir: string,
  ) => Promise<ConnectorSkillLockEntry[]>;
  /** Catalog keyed by entry id — resolves a composio connector's toolkit. */
  catalogByIdMap: () => Promise<Map<string, ConnectorCatalogEntry>>;
  /** Catalog keyed by entry url — resolves a DCR connector's canonical name. */
  catalogByUrl: () => Promise<Map<string, ConnectorCatalogEntry>>;
}

export interface ConnectorSkillReconcileResult {
  workspacesScanned: number;
  connectorsRefreshed: number;
}

// Catalog maps are only needed to derive an identity for a connector that has
// never bound (no lock). Cached across the whole run and fetched at most once, so
// a fleet with everything already bound never touches the catalog.
interface CatalogCache {
  byId?: Map<string, ConnectorCatalogEntry>;
  byUrl?: Map<string, ConnectorCatalogEntry>;
  failed?: boolean;
}

export async function reconcileConnectorSkills(
  deps: ConnectorSkillReconcileDeps,
): Promise<ConnectorSkillReconcileResult> {
  const workspaces = await deps.listWorkspaces();
  const catalog: CatalogCache = {};
  let connectorsRefreshed = 0;

  for (const ws of workspaces) {
    let changed = false;
    const nextBundles: BundleRef[] = [];
    for (const ref of ws.bundles) {
      if (!("url" in ref)) {
        nextBundles.push(ref); // registry (`{name}`) / sideload (`{path}`) — no overlay
        continue;
      }
      const updated = await reconcileRef(ref, ws.id, deps, catalog);
      if (updated !== ref) connectorsRefreshed++;
      changed ||= updated !== ref;
      nextBundles.push(updated);
    }
    if (changed) await persist(deps, ws.id, nextBundles);
  }

  return { workspacesScanned: workspaces.length, connectorsRefreshed };
}

/** Reconcile one connector; returns a new ref when refreshed, else the same ref. */
async function reconcileRef(
  ref: ConnectorRef,
  wsId: string,
  deps: ConnectorSkillReconcileDeps,
  catalog: CatalogCache,
): Promise<BundleRef> {
  const boundVersion = ref.skillsLock?.[0]?.version;
  if (boundVersion === deps.pinnedVersion) return ref; // already current

  const serverName = serverNameFromRef(ref);
  const identity = await resolveIdentity(ref, serverName, deps, catalog);
  if (!identity) return ref;

  let lock: ConnectorSkillLockEntry[] = [];
  try {
    lock = await deps.syncBoundSkills(identity, serverName, wsId, deps.workDir);
  } catch (err) {
    log.warn(
      `[connector-skills] reconcile: sync failed for ${serverName} (${identity}): ${errText(err)}`,
    );
  }

  // Only a successful fetch at a new version replaces the lock (syncBoundSkills
  // has already re-materialized the store file). An empty result — no curated
  // overlay, or a transient failure — leaves the connector untouched, so we
  // never clear a working overlay on a blip.
  if (lock.length > 0 && lock[0]!.version !== boundVersion) {
    return { ...ref, skillsLock: lock };
  }
  return ref;
}

/**
 * An already-bound ref's lock identity is authoritative (the exact string last
 * passed to syncBoundSkills). Only a first bind (no lock) needs the catalog to
 * derive the identity from the composio toolkit or the canonical reverse-DNS name.
 */
async function resolveIdentity(
  ref: ConnectorRef,
  serverName: string,
  deps: ConnectorSkillReconcileDeps,
  catalog: CatalogCache,
): Promise<string | null> {
  const existing = ref.skillsLock?.[0]?.identity;
  if (existing) return existing;
  if (!(await loadCatalog(deps, catalog))) return null;

  const toolkit = ref.composio?.connectorId
    ? catalog.byId?.get(ref.composio.connectorId)?.composio?.toolkit
    : undefined;
  // A DCR connector's persisted url is its real endpoint, so the catalog yields
  // the canonical reverse-DNS id (`com.dropbox/mcp`) that connectorSkillIdentityFrom
  // needs — NOT the slugified serverName (`com-dropbox-mcp`).
  const canonicalName = catalog.byUrl?.get(ref.url)?.id ?? serverName;
  return connectorSkillIdentityFrom(toolkit, canonicalName);
}

/** Populate the catalog cache once; returns false if it can't be reached. */
async function loadCatalog(
  deps: ConnectorSkillReconcileDeps,
  catalog: CatalogCache,
): Promise<boolean> {
  if (catalog.failed) return false;
  if (catalog.byId && catalog.byUrl) return true;
  try {
    catalog.byId ??= await deps.catalogByIdMap();
    catalog.byUrl ??= await deps.catalogByUrl();
    return true;
  } catch (err) {
    catalog.failed = true;
    log.warn(
      `[connector-skills] reconcile: catalog unavailable, skipping first-binds: ${errText(err)}`,
    );
    return false;
  }
}

async function persist(
  deps: ConnectorSkillReconcileDeps,
  wsId: string,
  bundles: BundleRef[],
): Promise<void> {
  try {
    await deps.updateWorkspaceBundles(wsId, bundles);
  } catch (err) {
    log.warn(`[connector-skills] reconcile: persist failed for ${wsId}: ${errText(err)}`);
  }
}

/**
 * Boot wrapper: resolve the pinned version, run the reconcile, and swallow any
 * failure (never break boot). This is the seam `Runtime.start` calls.
 */
export async function bootReconcileConnectorSkills(
  deps: Omit<ConnectorSkillReconcileDeps, "pinnedVersion">,
): Promise<void> {
  const pinnedVersion = resolveConnectorSkillsConfig().version;
  try {
    const { connectorsRefreshed } = await reconcileConnectorSkills({ ...deps, pinnedVersion });
    if (connectorsRefreshed > 0) {
      log.info(
        `[connector-skills] reconciled ${connectorsRefreshed} connector overlay(s) to ${pinnedVersion}`,
      );
    }
  } catch (err) {
    log.warn(`[connector-skills] boot reconcile failed (non-fatal): ${errText(err)}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
