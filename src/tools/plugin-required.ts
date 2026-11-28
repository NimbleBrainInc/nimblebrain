/**
 * The required reconcile (ADR-0076, "Catalogs decide reach, and the kernel
 * keeps it"; ADR-0077, "Updates"): every item of every `required` catalog is
 * installed in every workspace, and nothing a required catalog no longer lists
 * stays. A kernel invariant, not a tool: the runtime runs it at boot, when a
 * workspace is created, and on an interval that also notices a listing that
 * could not be read before (`Runtime.reconcileRequiredPlugins`).
 *
 * **Workspaces only.** Policy decides presence in a workspace. A person's own
 * plugins are theirs; a person cannot install a required item for themselves
 * (`plugin-install.ts`), so no personal record is ever required.
 *
 * Per workspace, as its owner, through the one install path under the owner's
 * lifecycle lock (`installPlugin`, `updatePlugin`, `uninstallPlugin`):
 *
 * - **Present.** An entry of a readable required catalog with no record is
 *   installed; one whose record names another digest is updated, since the
 *   operator moved the pin; one installed before its catalog was required is
 *   installed again in place, which marks its record `required`.
 * - **Absent.** A `required` record whose catalog is configured, required and
 *   readable but no longer lists it, or whose catalog is no longer configured
 *   at all, is uninstalled. A required catalog that cannot be read decides
 *   nothing: its items stay until it can be. Nor does one whose listing
 *   dropped an entry as invalid: the dropped entry may be an item the
 *   publisher still lists, so the catalog removes nothing until its listing
 *   is clean, while its valid entries install and update as usual.
 * - **Demoted.** A `required` record whose catalog is now `available` loses
 *   the mark, and stays installed like any other.
 *
 * **Sign-in is each workspace's.** A required server that needs an OAuth
 * sign-in is installed as a connection awaiting it, as any catalog install
 * is: present, listed with status `not_connected`, and an admin's Connect
 * signs it in for the workspace. Nobody is signed in on another's behalf. A
 * `static` server whose OAuth client neither the instance (`connectors.oauthClients`)
 * nor the workspace holds cannot be installed, so it fails until one is set.
 *
 * **Idempotent and isolated.** A workspace with nothing to do reads its records
 * and returns, fetching nothing. Each item stands alone: one that fails is
 * logged (once per distinct reason) and tried again on the next pass, and
 * never stops another item or another workspace. Workspaces run
 * {@link REQUIRED_CONCURRENCY} at a time.
 */

import type { CatalogSnapshot } from "../catalogs/reader.ts";
import type { CatalogPolicy } from "../config/catalogs.ts";
import type { ToolResult } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import type { InstalledPluginRecord, PluginOwner } from "../plugins/installed/record.ts";
import {
  installPlugin,
  oneAtATime,
  type PluginInstallContext,
  uninstallPlugin,
  updatePlugin,
} from "./plugin-install.ts";

/** How many workspaces one pass reconciles at once. */
export const REQUIRED_CONCURRENCY = 4;

/** One act of the reconcile, or one that failed. */
export interface RequiredAct {
  wsId: string;
  address: string;
}

export interface RequiredReconcileResult {
  installed: RequiredAct[];
  updated: RequiredAct[];
  removed: RequiredAct[];
  demoted: RequiredAct[];
  failed: Array<RequiredAct & { error: string }>;
}

export interface RequiredReconcileOptions {
  /** Reconcile these workspaces only (a workspace just created); default every one. */
  wsIds?: readonly string[];
  concurrency?: number;
}

/** What a pass knows about each configured catalog. */
interface CatalogView {
  policy: CatalogPolicy;
  /** The listed addresses and their digests, or null when the catalog could not be read. */
  listed: Map<string, string | undefined> | null;
  /** Whether an address missing from `listed` was dropped by the publisher: read, and no entry rejected. */
  decidesAbsence: boolean;
}

/** The reasons already logged per workspace and item, so a failure repeated each pass logs once. */
const reported = new Map<string, string>();

/** The listings (catalog and sha256) already logged as holding removals, so each logs once. */
const held = new Set<string>();

/** Run one pass. Never throws: a failure is in `failed`. */
export async function reconcileRequiredPlugins(
  ctx: PluginInstallContext,
  opts: RequiredReconcileOptions = {},
): Promise<RequiredReconcileResult> {
  const result: RequiredReconcileResult = {
    installed: [],
    updated: [],
    removed: [],
    demoted: [],
    failed: [],
  };
  const listings = ctx.runtime.getCatalogListings();
  const views = catalogViews(listings.catalogs(), await listings.snapshots());
  const store = ctx.runtime.getWorkspaceStore();
  const wsIds = opts.wsIds ?? (await store.list()).map((ws) => ws.id);

  let next = 0;
  const worker = async () => {
    while (next < wsIds.length) {
      const wsId = wsIds[next++] as string;
      try {
        await reconcileWorkspace(ctx, wsId, views, result);
      } catch (err) {
        fail(result, { wsId, address: "*" }, err instanceof Error ? err.message : String(err));
      }
    }
  };
  const width = Math.max(1, Math.min(opts.concurrency ?? REQUIRED_CONCURRENCY, wsIds.length));
  await Promise.all(Array.from({ length: width }, worker));

  const changed =
    result.installed.length + result.updated.length + result.removed.length + result.demoted.length;
  if (changed > 0) {
    log.info(
      `[plugins] required reconcile: ${result.installed.length} installed, ${result.updated.length} updated, ${result.removed.length} removed, ${result.demoted.length} no longer required`,
    );
  }
  return result;
}

function catalogViews(
  catalogs: ReadonlyArray<{ name: string; policy: CatalogPolicy }>,
  snapshots: readonly CatalogSnapshot[],
): Map<string, CatalogView> {
  const views = new Map<string, CatalogView>();
  for (const catalog of catalogs) {
    const snapshot = snapshots.find((s) => s.catalog.name === catalog.name);
    const readable = snapshot !== undefined && snapshot.origin !== "none";
    const rejected = readable ? snapshot.diagnostics.length : 0;
    if (rejected > 0 && catalog.policy === "required") {
      const key = `${catalog.name} ${snapshot?.sha256}`;
      if (!held.has(key)) {
        held.add(key);
        log.warn(
          `[plugins] required catalog "${catalog.name}" dropped ${rejected} invalid entries; it removes nothing until its listing is clean, and an installed item it dropped stays as it is`,
        );
      }
    }
    views.set(catalog.name, {
      policy: catalog.policy,
      listed: readable ? new Map(snapshot.entries.map((e) => [e.address, e.digest])) : null,
      decidesAbsence: readable && rejected === 0,
    });
  }
  return views;
}

/** The catalog part of `name@catalog`. */
function catalogOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** One workspace's pass: what it needs and what it holds. */
interface WorkspacePass {
  ctx: PluginInstallContext;
  wsId: string;
  owner: PluginOwner;
  result: RequiredReconcileResult;
  /** Make the workspace's registry, once, before the first act. */
  ready: () => Promise<unknown>;
}

async function reconcileWorkspace(
  ctx: PluginInstallContext,
  wsId: string,
  views: Map<string, CatalogView>,
  result: RequiredReconcileResult,
): Promise<void> {
  const owner: PluginOwner = { kind: "workspace", wsId };
  const records = await ctx.runtime.getPluginRecords().list(owner);
  // A connection registers in the workspace's registry; a workspace created
  // since boot has none until something asks. Made only when there is an act.
  let registry: Promise<unknown> | null = null;
  const ready = () => {
    registry ??= ctx.runtime.ensureWorkspaceRegistry(wsId);
    return registry;
  };
  const pass: WorkspacePass = { ctx, wsId, owner, result, ready };
  const byAddress = new Map(records.map((r) => [r.address, r]));
  for (const view of views.values()) {
    if (view.policy !== "required" || !view.listed) continue;
    for (const [address, digest] of view.listed) {
      await ensurePresent(pass, address, digest, byAddress.get(address));
    }
  }
  for (const record of records) {
    if (record.required) await ensureStillRequired(pass, record, views);
  }
}

/** Install, update or mark one listed item, as its record says it needs. */
async function ensurePresent(
  pass: WorkspacePass,
  address: string,
  digest: string | undefined,
  record: InstalledPluginRecord | undefined,
): Promise<void> {
  const { ctx, wsId, owner, result } = pass;
  if (record && record.digest === digest && record.required) {
    clearReported(wsId, address);
    return;
  }
  const act = { wsId, address };
  const update = record !== undefined && record.digest !== digest;
  await pass.ready();
  const done = update
    ? await updatePlugin(ctx, owner, address)
    : await installPlugin(ctx, owner, address);
  if (done.isError) return fail(result, act, errorOf(done));
  clearReported(wsId, address);
  (update ? result.updated : result.installed).push(act);
}

/** Keep a required record its catalog still requires; demote or remove one it does not. */
async function ensureStillRequired(
  pass: WorkspacePass,
  record: InstalledPluginRecord,
  views: Map<string, CatalogView>,
): Promise<void> {
  const { ctx, wsId, owner, result } = pass;
  const act = { wsId, address: record.address };
  const view = views.get(catalogOf(record.address));
  if (view?.policy === "available") {
    await demote(ctx, owner, record);
    result.demoted.push(act);
    return;
  }
  // A required catalog that cannot be read, or that rejected an entry, decides no removal.
  if (view && (!view.decidesAbsence || view.listed?.has(record.address))) return;
  await pass.ready();
  const done = await uninstallPlugin(ctx, owner, record.address, { asReconcile: true });
  if (done.isError) fail(result, act, errorOf(done));
  else result.removed.push(act);
}

/** Drop `required` from a record whose catalog is now offered rather than required. */
function demote(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  record: InstalledPluginRecord,
): Promise<void> {
  return oneAtATime(owner, async () => {
    const store = ctx.runtime.getPluginRecords();
    const current = await store.get(owner, record.address);
    if (!current?.required) return;
    const { required: _required, ...rest } = current;
    await store.put(owner, rest);
  });
}

function errorOf(result: ToolResult): string {
  const sc = result.structuredContent as { message?: unknown; error?: unknown } | undefined;
  if (typeof sc?.message === "string") return sc.message;
  const text = result.content.find((c) => c.type === "text");
  return text && "text" in text ? text.text : String(sc?.error ?? "failed");
}

function fail(result: RequiredReconcileResult, act: RequiredAct, error: string): void {
  result.failed.push({ ...act, error });
  const key = `${act.wsId} ${act.address}`;
  if (reported.get(key) === error) return;
  reported.set(key, error);
  log.warn(
    `[plugins] required ${act.address} is not in workspace ${act.wsId} yet; the next pass tries again: ${error}`,
  );
}

function clearReported(wsId: string, address: string): void {
  reported.delete(`${wsId} ${address}`);
}
