# Runtime

Scope: `src/runtime/`. The run-start door is `Runtime.startRun`; why there is one door is ADR-0021.

## Run admission

Every unattended run is admitted at the door: `executeTask` holds one of the runtime's run slots for as long as the run executes (`src/runtime/admission.ts`, created by `Runtime.getRunAdmission`, sized by `automations.maxConcurrentRuns` / `maxQueuedRuns`). A source inherits it by calling `executeTask`; it never re-implements it (ADR-0045).

- **Chat is not admitted.** `startRun` itself takes no slot; only `executeTask` does. A person in the loop is not capacity the runtime schedules.
- **The door knows no sources.** A request names the run's `workspaceId` and, optionally, an opaque `key` the caller chose; a key already holding a slot or waiting is refused (`running` / `queued`). Never branch admission on what a key means. A source namespaces its keys (the scheduler's are `automation:…`) so its withdrawals touch only its own runs.
- **A slot is a lease, released on every exit.** `executeTask` releases in a `finally`, including when the request is refused before the engine starts. `release` is idempotent, so a caller that handed in a lease releases it again on its own exit paths.
- **A caller that must answer at request time holds the slot itself.** `request(req, waiter)` says at once whether the run was admitted, queued (with its position in arrival order), or refused; the waiter's `admitted` / `withdrawn` callbacks run synchronously when the slot is granted or the entry leaves the queue. The caller passes the lease as `TaskRequest.admission`. A lease the pool does not hold is ignored and the run acquires its own, so a stray lease never bypasses the limit.
- **Without a waiter, a request never queues** (`busy`): for a caller whose place in line is durable elsewhere, such as a scheduled run's persisted next run. A free slot with runs waiting is not offered to it.
- **Fair share decides who takes a freed slot**: the waiting run whose workspace holds the fewest slots, the oldest among equals. A workspace alone in the queue takes every slot.
- **The queue is in memory.** `shutdown` stops admission after the sources are gone, refusing what nothing would drain.
