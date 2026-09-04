/**
 * Workspace-aware bundle lifecycle helpers.
 *
 * These functions build a process inventory from workspace definitions and
 * manage hot install/uninstall of bundles within individual workspaces.
 * Each workspace gets its own ToolRegistry with plain tool names (no compound keys).
 */

import { join } from "node:path";
import { brokeredConnectionPresent, bundleHasStaticAuth } from "../bundles/bundle-auth.ts";
import { assertBundleRefIsPostStage2 } from "../bundles/lifecycle.ts";
import { hasPersistedWorkspaceOAuthTokens } from "../bundles/oauth-tokens.ts";
import { resolveBundleDataDirForRef, serverNameFromRef } from "../bundles/paths.ts";
import { setPendingAuth } from "../bundles/pending-auth-buffer.ts";
import type { BundleMcpDeps } from "../bundles/startup.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type { BundleRef, LocalBundleMeta } from "../bundles/types.ts";
import {
  type ManagedConnectorRegistry,
  managedConnectorRegistryOf,
} from "../connectors/providers/registry.ts";
import type { EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { isHttpUrl } from "../util/url.ts";
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
  /**
   * Set when boot-start failed for an installed URL bundle. The entry survives
   * so the bundle keeps its lifecycle instance and placements, but the message
   * is what stops the seeder from recording an inaccurate `running` — it seeds
   * `dead` with this as `lastError` instead. Absent means the bundle either
   * started or was never attempted (the not-authenticated skip).
   */
  startError?: string;
}

// ---------------------------------------------------------------------------
// Process inventory
// ---------------------------------------------------------------------------

/**
 * Name an unusable `bundles[]` row for an operator, without assuming its shape.
 * A legacy row carries `name:` or `path:` where `url` should be; a malformed
 * one carries neither.
 */
function describeUnusableRef(ref: BundleRef): string {
  const legacy = ref as unknown as { name?: unknown; path?: unknown };
  if (typeof legacy.name === "string") return `legacy name: "${legacy.name}"`;
  if (typeof legacy.path === "string") return `legacy path: "${legacy.path}"`;
  if (typeof ref.url === "string") return `unusable url: ${JSON.stringify(ref.url)}`;
  return `no url and no legacy key (keys: ${Object.keys(ref).join(", ") || "none"})`;
}

/**
 * Build a flat process inventory from a list of workspaces.
 *
 * For each workspace, iterates its declared connectors and produces one
 * ProcessInventoryEntry per (workspace, connector) pair. The `dataDir` is
 * workspace-scoped via `resolveBundleDataDirForRef`.
 */
export function buildProcessInventory(
  workspaces: Workspace[],
  workDir: string,
): ProcessInventoryEntry[] {
  const entries: ProcessInventoryEntry[] = [];

  for (const ws of workspaces) {
    for (const bundle of ws.bundles) {
      // Disk-read boundary: refs carrying the legacy `oauthScope: "user"`
      // literal hard-error here. Operators are expected to have run
      // `bun run migrate:user-creds` before deploying Stage 2 — see
      // the Stage 2 deploy runbook.
      assertBundleRefIsPostStage2(bundle);
      // A row this build can neither name nor reach is skipped, not thrown on.
      // Boot reads every workspace's `bundles[]` in one pass before any
      // per-entry containment, so throwing here takes the whole instance down
      // over one bad row — a legacy `name:`/`path:` entry that predates the
      // URL-only ref, or a url that is blank or unparseable. Dropping just
      // that entry is what makes the documented per-entry break ("that entry
      // no longer starts") true, and the warn names the row so it can be
      // fixed. `serverNameFromRef` is the single predicate: it returns null on
      // exactly the rows nothing downstream could have used.
      const serverName = serverNameFromRef(bundle);
      if (serverName === null || !isHttpUrl(bundle.url)) {
        log.warn(
          `[bundles] ${ws.id}: skipping a connector entry with no reachable url — ` +
            `${describeUnusableRef(bundle)}. A connector is addressed by URL; ` +
            "re-install it from the catalog against the server's endpoint.",
        );
        continue;
      }
      const dataDir = resolveBundleDataDirForRef(workDir, ws.id, bundle);

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

/** URL bundle variant of `BundleRef` (the remote-connector shape). */
type UrlBundleRef = BundleRef;

/**
 * Whether a boot-time URL bundle already has credentials to auto-start with.
 *
 * A brokered bundle carries static auth but may STILL need a per-owner connect,
 * so its provider is asked FIRST — it is static-auth by transport, but must not
 * skip the connect gate. Other static-auth sources (provider / bearer / header)
 * carry their own credential and mint/present on demand — boot-start them. Only
 * OAuth bundles gate on persisted tokens.
 */
function urlBundleHasBootAuth(
  managedConnectors: ManagedConnectorRegistry,
  bundle: UrlBundleRef,
  wsId: string,
  serverName: string,
  workDir: string,
): boolean {
  return (
    brokeredConnectionPresent(managedConnectors, bundle, wsId, workDir) ??
    (bundleHasStaticAuth(bundle) || hasPersistedWorkspaceOAuthTokens(workDir, wsId, serverName))
  );
}

/**
 * Inventory entry for an installed URL bundle that is NOT running after the boot
 * loop — either never attempted (no tokens yet) or attempted and failed
 * (`startError`).
 *
 * The entry survives either way because installed and running are independent
 * facts. Only surviving entries reach `seedWorkspaceBundleInstances`, so a
 * dropped entry costs the bundle its lifecycle instance AND its placements: the
 * app vanishes from the shell, and `tryRecoverSource` — which resolves the ref
 * off that instance — can never revive it. Keeping it means the app stays
 * visible with an honest connection state and heals on next use.
 *
 * The placements ride on the ref itself — `buildSeededInstance` reads
 * `ref.ui` first — so they survive with the entry. `meta.ui` mirrors the same
 * value only to keep the `LocalBundleMeta` shape whole; it is never the source.
 */
function unstartedUrlBundleEntry(
  entry: ProcessInventoryEntry,
  bundle: UrlBundleRef,
  startError?: string,
): ProcessInventoryEntry {
  return {
    ...entry,
    meta: {
      version: "remote",
      ui: bundle.ui ?? null,
      briefing: null,
    },
    ...(startError ? { startError } : {}),
  };
}

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
    /**
     * Fired when a boot-started URL bundle's connection later loses its
     * authorization mid-session (a tool call hit `UnauthorizedError`). Unlike
     * `onInteractiveAuthRequired` — which buffers via `setPendingAuth` because
     * `BundleLifecycleManager` doesn't exist yet at boot — this fires LATER
     * (on a post-boot tool call), by which time the runtime's late-bound
     * lifecycle exists, so the runtime wires it straight to
     * `recordConnectionStateChange(... "reauth_required")`.
     */
    onAuthLost?: (wsId: string, serverName: string) => void;
    /**
     * The configured brokered providers. A brokered bundle's boot readiness is
     * its provider's to answer (`hasConnection`); with none passed, every
     * bundle falls back to the generic static-auth / persisted-token check.
     */
    managedConnectors?: ManagedConnectorRegistry;
  },
): Promise<{ registries: Map<string, ToolRegistry>; entries: ProcessInventoryEntry[] }> {
  const workDir = opts?.workDir ?? join(process.env.NB_WORK_DIR ?? "", ".nimblebrain");
  const managedConnectors = opts?.managedConnectors ?? managedConnectorRegistryOf([]);
  const workspaces = await workspaceStore.list();
  const inventory = buildProcessInventory(workspaces, workDir);

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

    // URL bundles without persisted tokens skip auto-start at boot —
    // there's nothing to connect with. The Connection sits in
    // `not_authenticated` until the user clicks Connect (which triggers
    // `lifecycle.startAuth`). This is what keeps a fresh install silent
    // — no surprise OAuth banner on a bundle the user added but hasn't
    // authenticated yet. `seedInstance` consults the same token check to
    // set state.
    //
    // A brokered bundle's readiness is its provider's answer, not a token file
    // — mirrors the discriminator in `lifecycle.seedUrlConnectionState`, which
    // consumes the same predicate.
    //
    // Stage 2: every URL bundle is workspace-scoped (the legacy
    // `oauthScope: "user"` literal was deleted). Personal connectors
    // bind to the owning user's personal workspace at install time.
    if (
      !urlBundleHasBootAuth(managedConnectors, entry.bundle, entry.wsId, entry.serverName, workDir)
    ) {
      log.info(
        `[bundles] Skipping boot start for URL bundle "${entry.serverName}" — no tokens yet (state: not_authenticated)`,
      );
      resultEntries[idx] = unstartedUrlBundleEntry(entry, entry.bundle);
      return;
    }

    try {
      const result = await startBundleSource(entry.bundle, wsRegistry, eventSink, {
        allowInsecureRemotes: opts?.allowInsecureRemotes,
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
        onInteractiveAuthRequired: (authorizationUrl: string) => {
          setPendingAuth(entry.wsId, entry.serverName, authorizationUrl);
        },
        // Mid-session auth loss fires post-boot (a tool call), so the
        // runtime's late-bound lifecycle exists by then — wire straight
        // through to flip the Connection to reauth_required.
        ...(opts?.onAuthLost
          ? { onAuthLost: () => opts.onAuthLost?.(entry.wsId, entry.serverName) }
          : {}),
        // Re-register inbound host-resources handlers on respawn so bundles
        // installed with host-resources support don't silently lose the
        // capability across platform restarts.
        bundleMcp: opts?.getBundleMcpDeps?.(entry.wsId),
        // Boot is the one caller that wants a failed URL start to stay in the
        // registry. Nobody is watching this start, the dependency being
        // unreachable for the few seconds the loop runs says nothing about
        // whether the bundle works, and an unregistered source is invisible to
        // HealthMonitor — so dropping it converts a transient outage into a
        // connector that stays gone until the next restart.
        keepRegisteredOnStartFailure: true,
      });
      // Use the actual source name from the registry (may differ from path-derived name)
      resultEntries[idx] = { ...entry, serverName: result.sourceName, meta: result.meta };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[workspace-runtime] Failed to start ${entry.serverName} in ${wsId}: ${msg}\n`,
      );
      // A URL bundle that failed to start is still installed, and the failure is
      // often transient — a dependency that was mid-roll when this loop ran, and
      // is reachable seconds later. Two things keep it recoverable, and it needs
      // BOTH: the inventory entry survives (see `unstartedUrlBundleEntry`) so the
      // lifecycle instance and its placements live on, and
      // `keepRegisteredOnStartFailure` above leaves the source itself in the
      // registry so `HealthMonitor` reconnects it without anyone asking. The
      // seeder still reads `startError` and records the connection `dead`, not
      // `running` — the bundle is registered, but its connection is honestly down
      // until a reconnect succeeds.
      //
      // Named/path bundles stay dropped, for two reasons. The decisive one:
      // only a URL ref reaches `seedUrlConnectionState`, and
      // `buildSeededInstance` hardcodes `state: "running"` — so a surviving
      // named entry would seed a permanently *running* instance for a dead
      // bundle, which is worse than absence, not better. Second, re-spawning
      // one needs the credential-resolving `startBundleSource` path that
      // `tryRecoverSource` declines, so the entry would promise a recovery that
      // never comes.
      if ("url" in entry.bundle) {
        resultEntries[idx] = unstartedUrlBundleEntry(entry, entry.bundle, msg);
      }
    }
  });

  const finalEntries = resultEntries.filter((e): e is ProcessInventoryEntry => !!e);
  // A failed URL bundle survives as an entry (it stays installed), so the
  // started count excludes it explicitly — otherwise this line reads "20/20"
  // while three bundles are dead, and the one boot-time signal that a
  // dependency was unreachable disappears.
  //
  // The count and the failure tally are all this line promises. Recovery is not
  // its business, and asserting anything about it from here means asserting a
  // distant subsystem's behavior from inside the boot loop.
  const failed = finalEntries.filter((e) => e.startError).length;
  if (flat.length > 0) {
    const elapsedMs = Date.now() - startMs;
    log.info(
      `[workspace-runtime] Started ${finalEntries.length - failed}/${flat.length} bundles in ${elapsedMs}ms (concurrency=${concurrency})${
        failed > 0 ? ` — ${failed} failed to start` : ""
      }`,
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
