/**
 * One record write at a time, per owner: per workspace for `workspace.json`,
 * per person for `users/<id>/connectors.json`.
 *
 * The critical section is the whole read-through-write, not the write alone:
 * `WorkspaceStore.update` re-reads the record and replaces the patched fields
 * wholesale, so two callers that both read an empty map each write a map
 * containing only their own entry and the second erases the first. Holding the
 * section across the read is what makes a concurrent mutation see the previous
 * one's result.
 *
 * **The chain is keyed by record, not by field**, and that is the point.
 * `update` writes the WHOLE record, so a `hooks` write and a `notifications`
 * write racing on one workspace lose each other exactly as two `hooks` writes
 * would — each persists its own read of every other field. A per-field lock
 * would look correct and hold nothing. Every read-modify-write of a workspace
 * record belongs in here; a person's connector record takes the same chain
 * inside `IdentityConnectorStore`.
 *
 * A task never waits on its own chain: a section that awaited another write
 * to the same record would wait on itself. Callers that need a longer
 * critical section (a plugin's whole install) take a chain of their own
 * (`keyedChain`) and write through these inside it.
 *
 * In-process only, which is the same assumption `singleFlight` in
 * `hooks/reconcile.ts` already makes and is sufficient while a tenant runs one
 * runtime pod — see "Running more than one replica" in `src/api/AGENTS.md` — and
 * clustering this state belongs to that project rather than to a lock.
 */

/** Tasks run one at a time per key, in arrival order. */
export interface KeyedChain {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Whether a task is queued or running for `key`. */
  has(key: string): boolean;
}

export function keyedChain(): KeyedChain {
  const chains = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prior = chains.get(key) ?? Promise.resolve();
      // `then(task, task)` so a failed predecessor does not cancel the queue —
      // one caller's error must not strand every writer behind it.
      const next = prior.then(task, task);
      // The stored tail swallows settlement so a rejection here is never
      // unhandled; the real outcome reaches the caller through `next`.
      const tail = next.then(
        () => undefined,
        () => undefined,
      );
      chains.set(key, tail);
      void tail.then(() => {
        // Drop the entry only when nobody queued behind us, so the map does not
        // grow one permanent promise per key for the life of the process.
        if (chains.get(key) === tail) chains.delete(key);
      });
      return next;
    },
    has: (key) => chains.has(key),
  };
}

const workspaceWrites = keyedChain();
const personWrites = keyedChain();

export function serializePerWorkspace<T>(wsId: string, task: () => Promise<T>): Promise<T> {
  return workspaceWrites.run(wsId, task);
}

/** One write of a person's connector record at a time (`IdentityConnectorStore`). */
export function serializePerPerson<T>(userId: string, task: () => Promise<T>): Promise<T> {
  return personWrites.run(userId, task);
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
  return workspaceWrites.has(wsId);
}
