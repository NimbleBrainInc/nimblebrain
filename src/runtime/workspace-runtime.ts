/**
 * Workspace-aware bundle lifecycle helpers.
 *
 * These functions build a process inventory from workspace definitions and
 * manage hot install/uninstall of bundles within individual workspaces.
 * Each workspace gets its own ToolRegistry with plain tool names (no compound keys).
 */

import { join } from "node:path";
import { hasPersistedComposioConnection } from "../bundles/composio-connection.ts";
import { hasPersistedWorkspaceOAuthTokens } from "../bundles/oauth-tokens.ts";
import { resolveBundleDataDirForRef, serverNameFromRef } from "../bundles/paths.ts";
import { setPendingAuth } from "../bundles/pending-auth-buffer.ts";
import type { BundleMcpDeps } from "../bundles/startup.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type { BundleRef, LocalBundleMeta } from "../bundles/types.ts";
import { log } from "../cli/log.ts";
import type { EventSink } from "../engine/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import type { Workspace } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the process inventory — one per (workspace, bundle) pair. */
export interface ProcessInventoryEntry {
  /** Workspace id (e.g., "ws_engineering"). */
  wsId: string;
  /** The bundle reference from the workspace definition. */
  bundle: BundleRef;
  /** Absolute path to the workspace-scoped data directory for this bundle. */
  dataDir: string;
  /** Plain server name (e.g., "crm"). */
  serverName: string;
  /** Manifest metadata captured during startup (if available). */
  meta?: LocalBundleMeta | null;
}

// ---------------------------------------------------------------------------
// Process inventory
// ---------------------------------------------------------------------------

/**
 * Build a flat process inventory from a list of workspaces.
 *
 * For each workspace, iterates its declared bundles and produces one
 * ProcessInventoryEntry per (workspace, bundle) pair. The `dataDir`
 * is workspace-scoped via `resolveBundleDataDirForRef` (which keys the
 * slug on `manifest.name`, reading it from disk for path bundles).
 */
export function buildProcessInventory(
  workspaces: Workspace[],
  workDir: string,
  configDir?: string,
): ProcessInventoryEntry[] {
  const entries: ProcessInventoryEntry[] = [];

  for (const ws of workspaces) {
    for (const bundle of ws.bundles) {
      const serverName = serverNameFromRef(bundle);
      // Slug is keyed on `manifest.name` (read here for path bundles) so the
      // launch-path data dir and the seedInstance / briefing reader-path
      // data dir cannot disagree.
      const dataDir = resolveBundleDataDirForRef(workDir, ws.id, bundle, configDir);

      entries.push({
        wsId: ws.id,
        bundle,
        dataDir,
        serverName,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Workspace registry creation (shared by boot-time and JIT paths)
// ---------------------------------------------------------------------------

/**
 * Create a ToolRegistry for a workspace with platform sources and the system source.
 *
 * Both boot-time startup and JIT workspace provisioning use this function to
 * ensure consistent registry contents. Platform and system sources are added
 * directly (no SharedSourceRef wrapper) — `McpSource.stop()` is idempotent
 * (after the first call client/transport/server are nulled and subsequent
 * calls early-return), so the only place this matters is `Runtime.shutdown()`,
 * which already wants the source closed exactly once.
 */
export function createWorkspaceRegistry(
  platformSources: ToolSource[],
  systemSource: ToolSource | null,
): ToolRegistry {
  const wsRegistry = new ToolRegistry();

  for (const src of platformSources) {
    wsRegistry.addSource(src);
  }

  if (systemSource) {
    wsRegistry.addSource(systemSource);
  }

  return wsRegistry;
}

// ---------------------------------------------------------------------------
// Workspace-scoped bundle startup
// ---------------------------------------------------------------------------

/**
 * Start all bundles across all workspaces, returning a per-workspace ToolRegistry.
 *
 * Reads workspaces from the store, builds the process inventory,
 * and spawns one bundle process per entry. Each workspace gets its own
 * ToolRegistry containing:
 * - Platform sources (in-process MCP — conversations, files, home, etc.)
 * - System source (`nb`, in-process MCP)
 * - Workspace-specific bundle sources (subprocess or remote MCP)
 *
 * Returns a Map<wsId, ToolRegistry> plus the inventory entries for lifecycle seeding.
 */
export async function startWorkspaceBundles(
  workspaceStore: WorkspaceStore,
  platformSources: ToolSource[],
  systemSource: ToolSource | null,
  // Required. Propagated to every McpSource so task-augmented tool calls
  // can emit `tool.progress` events that reach the SSE broadcast layer.
  // Pass `new NoopEventSink()` only if intentionally discarding events.
  eventSink: EventSink,
  configDir: string | undefined,
  opts?: {
    allowInsecureRemotes?: boolean;
    workDir?: string;
    /**
     * Per-workspace host-resources deps factory. Threaded into
     * `startBundleSource` so re-spawned bundles register inbound
     * `ai.nimblebrain/resources/*` handlers across platform restarts —
     * without this, every restart silently loses host-resources support
     * until the next reinstall. Runtime threads `Runtime.getBundleMcpDeps`
     * through here.
     */
    getBundleMcpDeps?: (wsId: string) => BundleMcpDeps | undefined;
  },
): Promise<{ registries: Map<string, ToolRegistry>; entries: ProcessInventoryEntry[] }> {
  const workDir = opts?.workDir ?? join(process.env.NB_WORK_DIR ?? "", ".nimblebrain");
  const workspaces = await workspaceStore.list();
  const inventory = buildProcessInventory(workspaces, workDir, configDir);

  // Group inventory by workspace
  const byWorkspace = new Map<string, ProcessInventoryEntry[]>();
  for (const entry of inventory) {
    const list = byWorkspace.get(entry.wsId) ?? [];
    list.push(entry);
    byWorkspace.set(entry.wsId, list);
  }

  // Also create registries for workspaces with no bundles
  for (const ws of workspaces) {
    if (!byWorkspace.has(ws.id)) {
      byWorkspace.set(ws.id, []);
    }
  }

  const registries = new Map<string, ToolRegistry>();
  for (const wsId of byWorkspace.keys()) {
    registries.set(wsId, createWorkspaceRegistry(platformSources, systemSource));
  }

  // Flatten (wsId, entry) pairs and start them through a bounded worker pool.
  // Sequential startup bottlenecked on Python interpreter cold-start for each
  // bundle subprocess; concurrent fan-out lets k8s/CPU overlap them. Capped to
  // keep peak memory/CPU bounded regardless of installed-bundle count — a pod
  // with many bundles won't OOM-kill itself on boot.
  //
  // Note: if a workspace ever declares two bundles that resolve to the same
  // serverName, the loser still fails with "already registered" (per-entry
  // try/catch keeps siblings unaffected), but *which one loses* is now
  // completion-ordered rather than declaration-ordered. Workspace definitions
  // shouldn't contain duplicates — this is a note for future incident triage,
  // not a fix target.
  const flat = Array.from(byWorkspace.entries()).flatMap(([wsId, wsEntries]) =>
    wsEntries.map((entry) => ({ wsId, entry })),
  );
  const resultEntries: ProcessInventoryEntry[] = new Array(flat.length);
  const concurrency = resolveBundleStartConcurrency();
  const startMs = Date.now();

  await mapWithConcurrency(flat, concurrency, async ({ wsId, entry }, idx) => {
    const wsRegistry = registries.get(wsId);
    if (!wsRegistry) return; // unreachable: registries is keyed by every wsId in byWorkspace

    // User-scoped URL bundles don't auto-start at boot — there's no
    // user identity to authenticate as. Connections are created lazily
    // on first call from each user. We still record the bundle so it
    // appears in the workspace's installed list (Settings → Connectors
    // surface, via `manage_connectors.list_installed`) and the
    // lifecycle's seedInstance can wire it up with an empty
    // connections map.
    if ("url" in entry.bundle && entry.bundle.oauthScope === "user") {
      log.info(
        `[bundles] Skipping boot start for user-scoped URL bundle "${entry.serverName}" — connections created on-demand`,
      );
      resultEntries[idx] = {
        ...entry,
        meta: {
          version: "remote (member-scope)",
          ui: entry.bundle.ui ?? null,
          briefing: null,
          httpProxy: null,
          type: "plain" as const,
        },
      };
      return;
    }

    // Workspace-scoped URL bundles without persisted tokens also skip
    // auto-start at boot — there's nothing to connect with. The
    // Connection sits in `not_authenticated` until the user clicks
    // Connect (which triggers `lifecycle.startAuth`). This is what
    // keeps a fresh install silent — no surprise OAuth banner on a
    // bundle the user added but hasn't authenticated yet.
    // `seedInstance` consults the same token check to set state.
    //
    // Composio-backed bundles use a parallel credential namespace
    // (`credentials/composio/<connectorId>/connection.json`) so the
    // probe has to read the right artifact — mirrors the discriminator
    // in `lifecycle.seedInstance`.
    if ("url" in entry.bundle) {
      const scope = entry.bundle.oauthScope ?? "workspace";
      const hasAuth = entry.bundle.composio
        ? hasPersistedComposioConnection(workDir, entry.wsId, entry.bundle.composio.connectorId)
        : hasPersistedWorkspaceOAuthTokens(workDir, entry.wsId, entry.serverName);
      if (scope === "workspace" && !hasAuth) {
        log.info(
          `[bundles] Skipping boot start for workspace-scope URL bundle "${entry.serverName}" — no tokens yet (state: not_authenticated)`,
        );
        resultEntries[idx] = {
          ...entry,
          meta: {
            version: "remote",
            ui: entry.bundle.ui ?? null,
            briefing: null,
            httpProxy: null,
            type: "plain" as const,
          },
        };
        return;
      }
    }

    try {
      const result = await startBundleSource(entry.bundle, wsRegistry, eventSink, configDir, {
        allowInsecureRemotes: opts?.allowInsecureRemotes,
        dataDir: entry.dataDir,
        // Thread workspace id + work dir so the named-bundle path can
        // resolve `user_config` from the workspace credential store before
        // prepareServer validates it.
        wsId: entry.wsId,
        workDir,
        // URL bundles that hit interactive OAuth fire this BEFORE
        // BundleLifecycleManager exists (it's constructed in
        // `Runtime.start` after this boot loop). Buffer the
        // authorization URL keyed by (wsId, serverName); lifecycle
        // consumes the buffer in `seedInstance` and constructs a
        // Connection in `pending_auth`. Without this, the pending_auth
        // signal would be silently dropped and the UI banner would
        // never appear for boot-time bundles.
        onInteractiveAuthRequired: (authorizationUrl) => {
          setPendingAuth(entry.wsId, entry.serverName, authorizationUrl);
        },
        // Re-register inbound host-resources handlers on respawn so bundles
        // installed with host-resources support don't silently lose the
        // capability across platform restarts.
        bundleMcp: opts?.getBundleMcpDeps?.(entry.wsId),
      });
      // Use the actual source name from the registry (may differ from path-derived name)
      resultEntries[idx] = { ...entry, serverName: result.sourceName, meta: result.meta };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[workspace-runtime] Failed to start ${entry.serverName} in ${wsId}: ${msg}\n`,
      );
    }
  });

  const finalEntries = resultEntries.filter((e): e is ProcessInventoryEntry => !!e);
  if (flat.length > 0) {
    const elapsedMs = Date.now() - startMs;
    log.info(
      `[workspace-runtime] Started ${finalEntries.length}/${flat.length} bundles in ${elapsedMs}ms (concurrency=${concurrency})`,
    );
  }
  return { registries, entries: finalEntries };
}

/**
 * Max bundles to start in parallel during `startWorkspaceBundles`. Override with
 * `NB_BUNDLE_START_CONCURRENCY`. Default 4 keeps peak memory/CPU bounded on a
 * 2-CPU/4Gi pod while capturing most of the serial→parallel win. Set to 1 for
 * legacy sequential behavior.
 */
export function resolveBundleStartConcurrency(): number {
  const raw = process.env.NB_BUNDLE_START_CONCURRENCY;
  if (raw === undefined || raw === "") return 4;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 4;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Preserves
 * per-item index so callers can write results into a pre-sized array without
 * worrying about completion order. Errors thrown by `worker` propagate — this
 * helper does not swallow them; the caller is responsible for per-item
 * try/catch when continue-on-failure is desired.
 *
 * Exported so it can be tested directly. Scope intentionally narrow — this is
 * not a general-purpose `p-limit` replacement; it's shaped for bounded fan-out
 * over a fixed list.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx] as T;
      await worker(item, idx);
    }
  });
  await Promise.all(runners);
}
