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

## Spend accounts

Every run may name spend accounts (`RunBudget.spendAccounts`, `TaskRequest.spendAccounts`), checked at the door (`src/runtime/spend.ts`, held by `Runtime.getSpendBalances`). Each is an opaque id the source chose, a unit (`usd`, `input_tokens`, `output_tokens`), and the amount remaining (ADR-0045).

- **One live balance per id while any run naming it is in flight.** The first run to name an id sets its unit and balance; every later run naming it draws on that same balance, so runs sharing an account cannot together exceed it. `startRun` holds the accounts for exactly as long as the engine runs and releases them in a `finally`; the last release discards the balance, and the source re-issues what is left on its next run.
- **The door never interprets an id.** Never branch on what an id means, parse it, or add a field naming a run's parent. Whether an id stands for a task, a batch, or a workspace is the source's knowledge (ADR-0021). A source namespaces its ids (the automations scheduler's are `automation-budget:…`).
- **Checked before each model call, debited after it.** The engine reaches the accounts only through `EngineConfig.spend` (a `SpendGate`): it projects the call's input as for `maxRunInputTokens` (the larger of the prompt estimate and the previous call's reported input) and its output at the call's `maxOutputTokens`, and ends the run with stopReason `spend_limit` and `spendAccountId` naming the first account the call would overrun. Pricing stays in the runtime: `usd` uses the run model's rates (`costBreakdown`), and a `usd` account on a model with no known rates lets no call through.
- **Debits are reported as they happen.** `onSpendDebit` gets each call's debit per account, with the balance after it. A throw from it is logged and never ends the run.
- **Chat names no account**, so it never opens a hold. Model calls outside the engine loop (title generation, mid-turn compaction) are not checked.
