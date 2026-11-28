/**
 * Boot-time reconcile of connector skills to the pinned plugin catalog.
 *
 * Curated connector skills otherwise bind only at connector *install*
 * (`syncBoundSkills` in the install path). The pin
 * (`resolvePluginCatalogConfig().sha256`) is deploy-time config that only
 * changes with a new image or env, i.e. a pod restart. So a pin bump never
 * reaches connectors that are already installed: their materialized skill +
 * `skillsLock` stay behind until the connector is reinstalled. This reconcile
 * closes that gap by running on boot (the one moment the pin can have changed)
 * and re-binding any connector whose lock is at another pin or absent. That
 * includes every lock written while skills came from the connector-skills
 * repo, whose version is a git tag, so an upgrade moves existing installs onto
 * the catalog with no operator or agent action.
 *
 * Scope: only a connector with no installed-plugin record (ADR-0077). A
 * connection a plugin owns carries `installedBy` (set at install, or by the
 * adoption reconcile that runs earlier in boot, `src/tools/plugin-adopt.ts`)
 * and is skipped: its skills are the record's managed skills. This reconcile and
 * the resolver it calls remain only for connectors adoption left plain.
 *
 * Safety:
 * - Pin-gated: a connector already at the pin is skipped with no fetch and no
 *   write, so steady-state boots are near-free.
 * - Additive only: a bind that returns nothing (no plugin binds a skill to the
 *   server, or a transient failure: `syncBoundSkills` is best-effort and
 *   reports both as `[]`) leaves the connector *exactly as-is* and is retried
 *   next boot. The reconcile never clears a working overlay, so guidance removed
 *   from the catalog does not propagate to existing installs.
 * - Non-fatal: every connector and every workspace is guarded; a failure is
 *   logged and skipped, never propagated to boot.
 *
 * Cost note: a connector with no curated skill has no lock, so it never matches
 * the pin and is re-checked every boot. That is disk reads, not network: the
 * resolver caches the index by the pin and each plugin by its archive digest,
 * so the network is hit once per pin and once per changed plugin, ever.
 */

import {
  resolvePluginCatalogConfig,
  retiredConnectorSkillsEnv,
} from "../../config/plugin-catalog.ts";
import type { ConnectorCatalogEntry } from "../../connectors/catalog/types.ts";
import { log } from "../../observability/log.ts";
import { brokeredRef } from "./brokered.ts";
import { isUsableConnectorRef, serverNameFromRef } from "./paths.ts";
import type { ConnectorRef, ConnectorSkillLockEntry } from "./types.ts";

export interface ConnectorSkillReconcileDeps {
  /** The catalog pin every installed connector should track. */
  pinnedVersion: string;
  workDir: string;
  listWorkspaces: () => Promise<ReadonlyArray<{ id: string; connectors: ConnectorRef[] }>>;
  updateWorkspaceConnectors: (wsId: string, connectors: ConnectorRef[]) => Promise<unknown>;
  syncBoundSkills: (
    server: string,
    serverName: string,
    wsId: string,
    workDir: string,
  ) => Promise<ConnectorSkillLockEntry[]>;
  /** Catalog keyed by entry id — resolves a brokered connector's registry name. */
  catalogByIdMap: () => Promise<Map<string, ConnectorCatalogEntry>>;
  /** Catalog keyed by entry url — resolves a DCR connector's registry name. */
  catalogByUrl: () => Promise<Map<string, ConnectorCatalogEntry>>;
}

export interface ConnectorSkillReconcileResult {
  workspacesScanned: number;
  connectorsRefreshed: number;
}

// Catalog maps are only needed to find the registry name of a connector whose
// lock does not record one (never bound, or bound from the connector-skills repo). Cached across the whole run and fetched at most once, so
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
    const nextConnectors: ConnectorRef[] = [];
    // Reached only after `startWorkspaceConnectors`, whose disk-read boundary
    // has already refused any workspace record without a `connectors[]`. Keep
    // that order: this loop would answer such a record with a bare TypeError
    // instead of the boundary's error.
    for (const ref of ws.connectors) {
      const updated = await reconcileRef(ref, ws.id, deps, catalog);
      if (updated !== ref) connectorsRefreshed++;
      changed ||= updated !== ref;
      nextConnectors.push(updated);
    }
    if (changed) await persist(deps, ws.id, nextConnectors);
  }

  return { workspacesScanned: workspaces.length, connectorsRefreshed };
}

/** Reconcile one connector; returns a new ref when refreshed, else the same ref. */
async function reconcileRef(
  ref: ConnectorRef,
  wsId: string,
  deps: ConnectorSkillReconcileDeps,
  catalog: CatalogCache,
): Promise<ConnectorRef> {
  // A plugin's connection: its skills come from its installed-plugin record.
  if (ref.installedBy) return ref;
  const boundVersion = ref.skillsLock?.[0]?.version;
  if (boundVersion === deps.pinnedVersion) return ref; // already current

  const serverName = serverNameFromRef(ref);
  // A row boot skips (no serverName, or a url that is not http(s)) has no
  // source to bind an overlay to. Return it untouched rather than reconciling
  // something unreachable.
  if (serverName === null || !isUsableConnectorRef(ref)) return ref;
  const server = await resolveServer(ref, deps, catalog);
  if (!server) return ref;

  let lock: ConnectorSkillLockEntry[] = [];
  try {
    lock = await deps.syncBoundSkills(server, serverName, wsId, deps.workDir);
  } catch (err) {
    log.warn(
      `[connector-skills] reconcile: sync failed for ${serverName} (${server}): ${errText(err)}`,
    );
  }

  // Only a successful bind at a new pin replaces the lock (syncBoundSkills has
  // already re-materialized the store files). An empty result — no curated
  // skill, or a transient failure — leaves the connector untouched, so we never
  // clear a working overlay on a blip.
  if (lock.length > 0 && lock[0]!.version !== boundVersion) {
    return { ...ref, skillsLock: lock };
  }
  return ref;
}

/**
 * The registry name of the server a connector installs (`com.dropbox/mcp`),
 * which is what a plugin names. A lock that records one is authoritative (the
 * exact string last passed to syncBoundSkills). Otherwise the catalog answers:
 * by the stamped catalog id for a brokered connector, whose persisted url is a
 * per-install session, and by url for any other. A connector the catalog does
 * not list has no plugin to read skills from.
 */
async function resolveServer(
  ref: ConnectorRef,
  deps: ConnectorSkillReconcileDeps,
  catalog: CatalogCache,
): Promise<string | null> {
  const recorded = ref.skillsLock?.[0]?.server;
  if (recorded) return recorded;
  if (!(await loadCatalog(deps, catalog))) return null;
  return registryNameFromCatalog(ref, catalog.byId, catalog.byUrl);
}

/**
 * The registry name of the server a connector installs, from its skill lock
 * when that records one, else from the catalog: by the stamped catalog id for a
 * brokered connector, whose persisted url is a per-install session, and by url
 * for any other. Null for a connector the catalog does not list.
 */
export function registryNameFromCatalog(
  ref: ConnectorRef,
  byId: ReadonlyMap<string, ConnectorCatalogEntry> | undefined,
  byUrl: ReadonlyMap<string, ConnectorCatalogEntry> | undefined,
): string | null {
  const recorded = ref.skillsLock?.[0]?.server;
  if (recorded) return recorded;
  const brokeredId = brokeredRef(ref)?.connectorId;
  const brokered = brokeredId ? byId?.get(brokeredId) : undefined;
  return brokered?.id ?? byUrl?.get(ref.url)?.id ?? null;
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
      `[connector-skills] reconcile: catalog unavailable, skipping unrecorded binds: ${errText(err)}`,
    );
    return false;
  }
}

async function persist(
  deps: ConnectorSkillReconcileDeps,
  wsId: string,
  connectors: ConnectorRef[],
): Promise<void> {
  try {
    await deps.updateWorkspaceConnectors(wsId, connectors);
  } catch (err) {
    log.warn(`[connector-skills] reconcile: persist failed for ${wsId}: ${errText(err)}`);
  }
}

/**
 * Boot wrapper: resolve the catalog pin, run the reconcile, and swallow any
 * failure (never break boot). This is the seam `Runtime.start` calls.
 */
export async function bootReconcileConnectorSkills(
  deps: Omit<ConnectorSkillReconcileDeps, "pinnedVersion">,
): Promise<void> {
  const retired = retiredConnectorSkillsEnv();
  if (retired.length > 0) {
    log.warn(
      `[connector-skills] ${retired.join(", ")} ignored: connector skills come from the plugin catalog (NB_PLUGIN_CATALOG_URL, NB_PLUGIN_CATALOG_SHA256)`,
    );
  }
  try {
    const pinnedVersion = resolvePluginCatalogConfig().sha256;
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
