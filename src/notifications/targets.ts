import { WORKSPACE_PRINCIPAL_ID } from "../bundles/connection.ts";
import type { BundleLifecycleManager } from "../bundles/lifecycle.ts";
import type { PollTarget } from "./poller.ts";
import type { NotificationsDeclaration } from "./types.ts";

/**
 * Which `(workspace, connector)` pairs the poller may read this tick.
 *
 * Three conditions, and each one is somebody else's decision read back rather
 * than re-derived here:
 *
 *   - **The connector declares an outbox.** No declaration, no poll — for any
 *     reason. There is no scheme the runtime recognises as "this looks like an
 *     outbox", because publishing a right-shaped URI would then be the grant,
 *     which turns an opt-in into an opt-out.
 *   - **Its connection is `running`.** Not `starting`, not `reauth_required`,
 *     not `crashed`. A source in any other state either has no credential or is
 *     already being recovered by machinery that owns that job.
 *   - **Under the workspace principal.** A per-user connection authenticates as
 *     a person; an outbox belongs to the workspace that installed the
 *     connector, and reading one as a member would file the workspace's
 *     notifications under whoever happened to be connected.
 *
 * **Personal connectors are not polled.** An identity-plane connector is not a
 * `BundleInstance` at all: it is lazy-started per pod on the owner's first
 * dispatch and rests cold otherwise, so polling one would mean starting a
 * transport on a timer for a user who is not here — the opposite of the rule
 * that a source's own backoff is never overridden to fit a poll. When a
 * personal outbox is wanted, what it needs is a resting-state connection, not
 * an exception here.
 *
 * An idle-closed connection stays `running` with its transport torn down, and
 * that is deliberately still a target: the read heals it on demand, which is
 * the reconnect the poll budget is sized for. What is never revived is a
 * connection that left `running` — the poller skips it and lets the next tick
 * re-ask, rather than restarting a source whose own backoff is still running.
 */
export async function collectPollTargets(
  lifecycle: BundleLifecycleManager,
  declarationFor: (serverName: string) => Promise<NotificationsDeclaration | undefined>,
): Promise<PollTarget[]> {
  // One lookup per distinct connector per sweep. The catalog is shared across
  // workspaces, so a connector installed in twenty of them resolves once.
  const declarations = new Map<string, Promise<NotificationsDeclaration | undefined>>();
  const resolve = (serverName: string) => {
    const cached = declarations.get(serverName);
    if (cached) return cached;
    const pending = declarationFor(serverName);
    declarations.set(serverName, pending);
    return pending;
  };

  const targets: PollTarget[] = [];
  for (const instance of lifecycle.getInstances()) {
    const connection = instance.connections?.get(WORKSPACE_PRINCIPAL_ID);
    if (!connection || connection.state !== "running" || !connection.source) continue;
    const declaration = await resolve(instance.serverName);
    if (!declaration) continue;
    targets.push({
      wsId: instance.wsId,
      serverName: instance.serverName,
      resource: declaration.resource,
      source: connection.source,
    });
  }
  return targets;
}
