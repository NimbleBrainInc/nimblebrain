/**
 * Removing one connector from a workspace, as a function.
 *
 * Ten steps in a deliberate order, and the order is the whole of it: the
 * bundle is told it is going before anything it needs is gone, the upstream
 * grant is revoked while the ref that names it still exists, and the local
 * bookkeeping that outlives a source — hooks, cursors, watches, permissions —
 * is dropped last.
 *
 * It lives here rather than in `manage_connectors` because a workspace owns
 * its connectors: deleting the container has to run the same teardown as
 * removing each thing it holds, and a second implementation of these ten steps
 * would drift on the first step someone adds. `Runtime.deleteWorkspace` and the
 * tool's `uninstall` action are the two callers.
 *
 * What the TOOL keeps is what is genuinely the tool's: argument parsing, the
 * workspace-admin gate, deciding which of the connector's secret keys this
 * uninstall may take with it, and the prose. This function takes the resolved
 * keys as an argument for exactly that reason — "which keys may go" is a
 * question about the workspace record as it stands at the call, and a workspace
 * delete answers it differently (see {@link UninstallConnectorOptions}).
 */

import { revokeHooksForConnector } from "../../hooks/provisioning.ts";
import type { LifecycleNotifyDeps } from "../../lifecycle/notify.ts";
import { forgetReadyNotification, notifyRemoving } from "../../lifecycle/notify.ts";
import { clearCursor } from "../../notifications/cursors.ts";
import type { PermissionStore } from "../../permissions/permission-store.ts";
import { stopWatchingToolSurface } from "../../tools/connector-surface.ts";
import type { CredentialStore } from "../../tools/credential-store.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import type { ConnectorLifecycleManager } from "./lifecycle.ts";
import { matchesServerName } from "./paths.ts";

/**
 * The slice of the runtime a connector teardown reaches.
 *
 * Named as a structural interface rather than taking `Runtime` so
 * `src/connectors/` keeps no edge to the composition root — `Runtime` satisfies
 * it as written, so both call sites pass the runtime itself.
 */
export interface ConnectorTeardownDeps {
  getLifecycle(): ConnectorLifecycleManager;
  getLifecycleNotifyDeps(): LifecycleNotifyDeps;
  getRegistryForWorkspace(wsId: string): ToolRegistry;
  getWorkspaceStore(): WorkspaceStore;
  getPermissionStore(): PermissionStore;
  getCredentialStore(): CredentialStore;
  getWorkDir(): string;
  getAllowInsecureRemotes(): boolean;
}

export interface UninstallConnectorOptions {
  /**
   * The workspace credential keys this uninstall may delete — resolved by the
   * caller off the workspace record, because only the caller knows what else is
   * still standing.
   *
   * `manage_connectors` subtracts the keys a surviving sibling still names. A
   * workspace delete passes none: every connector is going, so the subtraction
   * has no meaning, and these keys are operator-set workspace secrets, which
   * survive the archive-rename — deleting them out from under it would destroy
   * exactly what the archive exists to keep.
   *
   * Not everything under `credentials/` survives, and that is deliberate rather
   * than an oversight this argument papers over: `lifecycle.uninstall` clears
   * the connector's own OAuth record keys (`mcp-oauth.<server>.*`) and any
   * brokered credential directory one step before the rename, because revoking
   * upstream is the point and a revoked token is not worth archiving.
   */
  secretKeys?: string[];
}

/** What became of the connector's own workspace secrets. */
export interface SecretDeleteOutcome {
  deleted: string[];
  failed: string[];
  error?: string;
}

/** What one connector's teardown did, reported rather than thrown. */
export interface ConnectorTeardownOutcome {
  serverName: string;
  /**
   * False when a step threw; the connector may be partly torn down.
   *
   * It reports the LOCAL teardown. Read `revoked` for whether the vendor was
   * told — the two can disagree.
   */
  ok: boolean;
  error?: string;
  /**
   * What the upstream revoke reported. **Absent with no `revokeError` means no
   * revoke was attempted** — the lifecycle held no live instance for this
   * connector, so there was no ref to revoke against and `cleanupBrokeredState`
   * had nothing to resolve either. Boot seeds an instance for every startable
   * row, so this is the already-gone case rather than an expected one; it is
   * distinguishable here rather than folded into `ok` precisely because `ok`
   * would read as "the grant is released" when nothing asked for its release.
   *
   * Absent WITH a `revokeError` is the other thing entirely: a revoke was
   * attempted and did not complete. `revoked` is non-optional on the
   * lifecycle's own return, so the only way it goes missing is that call
   * throwing — and that is a grant to go chase at the vendor, not one nobody
   * asked about.
   */
  revoked?: { access?: boolean; refresh?: boolean };
  revokeError?: string;
  secrets: SecretDeleteOutcome;
}

/**
 * Tear a connector out of a workspace.
 *
 * **Never throws.** A step that fails is reported in the outcome, because both
 * callers need to finish: an uninstall that half-ran is a state the admin can
 * act on, and a workspace delete must not be stranded by one connector nobody
 * can reach.
 *
 * The first two steps are best-effort by their own contract — `notifyRemoving`
 * never throws and the revoke catches — so they run ahead of the guarded block
 * and cannot turn a reachable connector's removal into a reported failure.
 *
 * Secrets go LAST, and that order matters. A delete that ran first and was
 * followed by a failed uninstall would leave a connector installed and unable
 * to connect. The reverse leaves the connector gone and a key behind, which is
 * a state the caller can act on — so a failed delete is reported, not rolled
 * back.
 */
export async function uninstallWorkspaceConnector(
  deps: ConnectorTeardownDeps,
  wsId: string,
  serverName: string,
  opts: UninstallConnectorOptions = {},
): Promise<ConnectorTeardownOutcome> {
  const lifecycle = deps.getLifecycle();
  const instance = lifecycle.getInstance(serverName, wsId);

  // Tell the connector it is being removed, BEFORE anything is torn down —
  // after the source is gone there is nothing left to call, and after the OAuth
  // tokens are revoked the call would fail. Best-effort by construction:
  // `notifyRemoving` never throws, and a bundle that cannot be reached is
  // logged and left behind rather than blocking a user's uninstall on a
  // vendor's availability.
  await notifyRemoving(deps.getLifecycleNotifyDeps(), wsId, serverName);

  // Revoke OAuth tokens upstream first when applicable.
  const revokeResult = instance?.ref
    ? await revokeUrlConnectorTokens(deps, lifecycle, serverName, wsId)
    : {};

  try {
    const registry = deps.getRegistryForWorkspace(wsId);
    // The only path that reaches `cleanupBrokeredState`, and so the only thing
    // that revokes a brokered connection at the vendor.
    await lifecycle.uninstall(serverName, registry, wsId);
    await stripUninstalledConnectorEntry(deps, wsId, serverName);
    // Retire every hook this connector held. The door independently refuses a
    // delivery for an uninstalled connector — it needs the connector's base URL
    // to have anywhere to forward to — so this is not the only thing that stops
    // one. It is what keeps a later reinstall from resurrecting a key id whose
    // URL has been in the wild the whole time.
    await revokeHooksForConnector(deps.getWorkspaceStore(), wsId, serverName);
    // And reset the outbox position. The cursor is the emitting server's own
    // opaque value, carrying an epoch it may reset while the connector is gone,
    // so a reinstall resuming from a stale one would ask a question its outbox
    // can no longer answer. Bootstrap costs only what was emitted while nobody
    // was installed to receive it.
    await clearCursor(deps.getWorkspaceStore(), wsId, serverName);
    // And drop the tool-set watches, whose closures would otherwise hold a
    // source nothing routes to any more, along with the per-process record that
    // this connector has already been told it is ready — a reinstall is a new
    // installation and must be told so.
    stopWatchingToolSurface(wsId, serverName);
    forgetReadyNotification(wsId, serverName);
    // Drop tool permissions for this connector — they have no meaning
    // once the connector is gone.
    await deps.getPermissionStore().deleteConnector({ scope: "workspace", wsId }, serverName);
    const secrets = await deleteOwnedSecrets(deps, wsId, opts.secretKeys ?? []);
    return { serverName, ok: true, secrets, ...revokeResult };
  } catch (err) {
    // Nothing has been deleted yet — the secrets go after the uninstall, so a
    // connector that is still installed still has its credentials.
    return {
      serverName,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      secrets: { deleted: [], failed: [] },
      ...revokeResult,
    };
  }
}

/**
 * Revoke a URL connector's OAuth tokens upstream before local cleanup. Best-effort:
 * a 4xx from the provider shouldn't block uninstall, since the user's intent is
 * "I want this gone."
 */
async function revokeUrlConnectorTokens(
  deps: ConnectorTeardownDeps,
  lifecycle: ConnectorLifecycleManager,
  serverName: string,
  wsId: string,
): Promise<{ revoked?: { access?: boolean; refresh?: boolean }; revokeError?: string }> {
  try {
    const r = await lifecycle.disconnect(serverName, wsId, "_workspace", {
      workDir: deps.getWorkDir(),
      allowInsecureRemotes: deps.getAllowInsecureRemotes(),
    });
    return {
      revoked: r.revoked,
      ...(r.revokeError ? { revokeError: r.revokeError } : {}),
    };
  } catch (err) {
    return { revokeError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Strip the just-uninstalled connector from `workspace.json#connectors[]`.
 * `lifecycle.uninstall` clears its own `instances` map and the legacy global
 * `nimblebrain.json`, but not the workspace record.
 */
async function stripUninstalledConnectorEntry(
  deps: ConnectorTeardownDeps,
  wsId: string,
  serverName: string,
): Promise<void> {
  const store = deps.getWorkspaceStore();
  const wsAfter = await store.get(wsId);
  if (!wsAfter) return;
  const filtered = wsAfter.connectors.filter((b) => !matchesServerName(b, serverName));
  if (filtered.length !== wsAfter.connectors.length) {
    await store.update(wsId, { connectors: filtered });
  }
}

/**
 * Remove the keys an uninstalled connector owned, reporting what went.
 *
 * Every key is attempted even after one fails: a partial delete that stopped at
 * the first error would leave the rest orphaned with nothing to say so. The
 * result is not an error — the uninstall succeeded, and the connector is gone
 * whether or not its key went with it.
 */
async function deleteOwnedSecrets(
  deps: ConnectorTeardownDeps,
  wsId: string,
  keys: string[],
): Promise<SecretDeleteOutcome> {
  if (keys.length === 0) return { deleted: [], failed: [] };
  const deleted: string[] = [];
  const failed: string[] = [];
  let firstError: string | undefined;
  // Inside the try with the deletes: `getCredentialStore` falls through to
  // `requireCredentialStore`, which THROWS when nothing installed a store. Left
  // outside, that throw reaches the caller's outer try and turns an uninstall
  // that already completed into a reported failure — the one thing the
  // uninstall-then-delete order exists to avoid claiming.
  try {
    const store = deps.getCredentialStore();
    for (const key of keys) {
      try {
        await store.delete({ kind: "workspace", wsId }, key);
        deleted.push(key);
      } catch (err) {
        failed.push(key);
        firstError ??= err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    // No store at all: every key is unresolved, and none of them went.
    return {
      deleted,
      failed: keys.filter((k) => !deleted.includes(k)),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { deleted, failed, ...(firstError ? { error: firstError } : {}) };
}
