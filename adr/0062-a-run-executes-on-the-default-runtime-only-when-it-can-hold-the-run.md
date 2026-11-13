# 0062. A run executes on the default runtime only when it can hold the run

- Status: Accepted; amended by ADR-0063
- Date: 2026-11-12
- Serves: orchestrate remote MCP
- Amends: [ADR-0056](./0056-an-agent-runtime-executes-what-the-door-decided.md) (what the door does with a run the default runtime cannot hold)

## Context

ADR-0056 has each runtime declare what it holds and the door refuse a run it
cannot hold. A run's spend accounts and its run-wide input-token cap are checked
before each model call by a spend gate, which only the native runtime has: an
external agent runs its own loop and calls the model gateway itself, so the
runtime never sees those calls.

With `execution.default` naming a worker, every task run that carries a token
budget or an input cap is therefore refused and recorded as failed. Making a
worker the default would fail the runs that limits exist to protect, so in
practice no installation can make it the default.

Refusing is right in one sense: a run must never spend unchecked. But the
installation already has a runtime that can hold the run. `execution.default`
states a preference among runtimes; the run's terms are requirements. A
requirement outranks a preference.

## Decision

The door executes a run on the runtime `execution.default` names when that
runtime declares every capability the run's terms need, and on the native
runtime otherwise. A run that names spend accounts or caps its input tokens
needs a spend gate; the native runtime always has one.

The choice is made once, at the door, before the run starts, from declared
capabilities. It is never a retry after a refusal, and it never depends on a
runtime's id. The door logs the run id, the default it passed over, and the term
that default could not hold; the run's `execution.bound` names the runtime that
ran it.

## Consequences

- A worker can be an installation's default. Chat and unbudgeted runs execute on
  it, budgeted and capped runs keep their checks on the native runtime, and no
  run fails because of where it was sent.
- "Default" means "preferred among the runtimes that can hold this run". An
  operator reading which runtime ran a given task reads its `execution.bound`,
  not the config.
- Budgeted runs never exercise the worker until a runtime other than the native
  one has a spend gate. Giving every runtime one is the model gateway enforcing
  each call against the runtime's spend ledger, since every model call on every
  runtime crosses it. That is a separate decision; once a worker declares
  `spendGate`, this rule sends nothing elsewhere and needs no change.
- `RuntimeCannotHoldRunError` is gone: the native runtime holds every term, so
  the door has no run left to refuse on these grounds.
