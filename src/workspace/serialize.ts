/**
 * One workspace-record write at a time, per workspace.
 *
 * The critical section is the whole read-through-write, not the write alone:
 * `WorkspaceStore.update` re-reads the record and replaces the patched fields
 * wholesale, so two callers that both read an empty map each write a map
 * containing only their own entry and the second erases the first. Holding the
 * section across the read is what makes a concurrent mutation see the previous
 * one's result.
 *
 * **The chain is keyed by workspace, not by field**, and that is the point.
 * `update` writes the WHOLE record, so a `hooks` write and a `notifications`
 * write racing on one workspace lose each other exactly as two `hooks` writes
 * would — each persists its own read of every other field. A per-field lock
 * would look correct and hold nothing. Every read-modify-write of a workspace
 * record belongs in here.
 *
 * In-process only, which is the same assumption `singleFlight` in
 * `hooks/reconcile.ts` already makes and is sufficient while a tenant runs one
 * runtime pod — the `replicas > 1` prerequisites in `AGENTS.md` are unmet, and
 * clustering this state belongs to that project rather than to a lock.
 */

const writeChains = new Map<string, Promise<unknown>>();

export function serializePerWorkspace<T>(wsId: string, task: () => Promise<T>): Promise<T> {
  const prior = writeChains.get(wsId) ?? Promise.resolve();
  // `then(task, task)` so a failed predecessor does not cancel the queue — one
  // caller's error must not strand every writer behind it.
  const next = prior.then(task, task);
  // The stored tail swallows settlement so a rejection here is never unhandled;
  // the real outcome reaches the caller through `next`.
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(wsId, tail);
  void tail.then(() => {
    // Drop the entry only when nobody queued behind us, so the map does not
    // grow one permanent promise per workspace for the life of the process.
    if (writeChains.get(wsId) === tail) writeChains.delete(wsId);
  });
  return next;
}

/**
 * Whether a write is currently queued or running for `wsId`.
 *
 * Read by the contention counter the notifications poller reports: an entry
 * present when a cursor write arrives means that write waited on someone
 * else's, which — hook reconciles being the only other frequent writer — is how
 * the two are observed contending for the record they share. Diagnostic only;
 * nothing branches on it.
 */
export function hasQueuedWorkspaceWrite(wsId: string): boolean {
  return writeChains.has(wsId);
}
