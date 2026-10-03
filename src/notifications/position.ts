import { log } from "../observability/log.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { readCursor, writeCursor } from "./cursors.ts";
import { NOTIFICATION_REPLAY_MAX_AGE_MS, outboxReadUri } from "./outbox-uri.ts";
import { parseOutboxPollBody } from "./poll-result.ts";
import type { PollTarget } from "./poller.ts";

/**
 * Give a connector's outbox a position before the connector is told it is ready.
 *
 * A first read with no cursor bootstraps: the server answers with no history
 * and a cursor past every row it holds, so a newly installed connector does not
 * open with a backlog nobody asked for. That is right for what predates the
 * install and wrong for what the install itself causes. `on_ready` is where a
 * connector starts its install-time work, and that work finishes in seconds,
 * well inside the poller's first sweep. Left to the poller, the bootstrap lands
 * after those events and steps over them, so what a connector says about its
 * own setup never reaches the inbox.
 *
 * So the lifecycle notification takes the bootstrap first, here, and only then
 * calls the handler. Every event the handler causes is then after the cursor,
 * and the poller's ordinary reads deliver it.
 *
 * A no-op when a cursor is already stored: a resume, a reboot, or the second of
 * an install's two racing `on_ready` calls. A poller bootstrap can race this
 * one and still be in flight when the handler runs. Both writes are
 * set-if-absent, so only the first lands: if it is this one, the poller's later
 * horizon is refused; if it is the poller's, that read had already returned
 * before this write, so before the handler was called.
 *
 * Best-effort, and it never fails the notification: a read that fails here
 * leaves the poller to bootstrap as it would have anyway. Returns whether a
 * position was written.
 */
export async function positionOutbox(
  workspaceStore: WorkspaceStore,
  target: PollTarget,
  maxEvents: number,
): Promise<boolean> {
  const ws = await workspaceStore.get(target.wsId);
  if (ws && readCursor(ws, target.serverName) !== undefined) return false;
  try {
    const uri = outboxReadUri(target.resource, {
      maxEvents,
      maxAgeMs: NOTIFICATION_REPLAY_MAX_AGE_MS,
    });
    const data = await target.source.readResource(uri, { reconnect: true, logFailures: true });
    // A bootstrap answers no events by contract. Any it did carry are history
    // by the same contract, which is what a position past them says.
    const cursor = parseOutboxPollBody(data?.text)?.cursor;
    if (cursor === undefined) return false;
    return await writeCursor(workspaceStore, target.wsId, target.serverName, cursor, {
      from: undefined,
    });
  } catch (err) {
    log.warn("[notifications] install-time outbox position failed; the poller will bootstrap", {
      source: target.serverName,
      wsId: target.wsId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
