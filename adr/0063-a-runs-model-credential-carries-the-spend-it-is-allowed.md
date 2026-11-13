# 0063. A run's model credential carries the spend it is allowed

- Status: Proposed
- Date: 2026-11-12
- Serves: orchestrate remote MCP
- Amends: [ADR-0045](./0045-a-task-is-the-unattended-primitive-and-its-trigger-is-optional.md) (how a run is held to its spend accounts), [ADR-0062](./0062-a-run-executes-on-the-default-runtime-only-when-it-can-hold-the-run.md) (which runtimes hold a run with spend accounts)

## Context

A run's terms (ADR-0045) bound what it may spend: an input-token cap that
belongs to the run alone, and spend accounts that several runs may draw on, such
as a task's budget for a period or a batch's budget. The native engine holds a
run to them before each model call. An external agent runs its own loop, so the
runtime never sees its calls, and ADR-0062 keeps every run with a cap or an
account on the native engine.

Every model call on every runtime carries the run's model credential, which the
runtime mints and the installation's model gateway verifies. The credential is
the run's capability to spend: the gateway admits nothing without one. A
capability should carry its own limit, so that whoever enforces it needs nothing
but the capability.

Two other places to enforce were considered and rejected. The agent: it would
enforce its own budget, and every ACP agent would need a NimbleBrain protocol.
A gateway that asks the runtime's ledger on every call: correct, but it makes
the gateway depend on the runtime being reachable, adds a round trip per call,
and opens a path from the gateway into the runtime, to answer a question the
runtime can settle once, when it mints the credential.

## Decision

The runtime writes into each run's model credential the most the run may spend,
and the gateway refuses the run's calls once its spend reaches that amount.

- **A per-run cap is granted as is.** It is the run's own and shares nothing.
- **A spend account is reserved, then settled.** When it mints the credential,
  the door reserves from each account the run names its share: the balance
  divided by the most runs that may draw on the account at once, priced at the
  model's dearest rates for a `usd` account. The source that names an account
  states that number beside it (a batch, its concurrency), since the door never
  interprets an account's id; an account that states none is shared by no other
  run. It grants the least of those reservations and the run's
  cap, and holds the reservations until the run ends, then debits what the run
  spent and releases the rest. The ledger stays the runtime's, and no other
  process reads or writes it.
- **The grant never exceeds what is held.** Where the gateway counts spend per
  replica, or can enforce only fixed amounts, the runtime divides by the replica
  count and rounds down to an amount the gateway can enforce. A run may be held
  below its terms, never above them.
- **The gateway counts input and output tokens together.** That is at least what
  an input-token cap counts, so it errs toward stopping early.
- **A runtime that reaches models only through such a gateway holds a run's
  terms.** ADR-0062's routing then keeps those runs on the default runtime.

The native engine keeps its own per-call check, which also clamps each call's
output to what remains.

## Consequences

- Budgeted and capped work runs on external runtimes with no change to any
  agent, and the gateway keeps no dependency on the runtime.
- A run on a shared account holds its share for its whole run, so a run that
  needs more than its share stops early even when the account has balance that
  other runs hold but will not use. The batch driver already waits for running
  runs to settle before it asks again.
- The gateway cannot shrink a call to what is left, so a run can overrun its
  grant by the output of its last call. The native engine keeps its exact clamp.
- Settlement debits the usage the agent reports, the same report the usage
  ledger prices. The gateway's grant is the hard bound on each run whatever the
  agent reports, so an agent that under-reports can misstate a shared account by
  at most one grant per run. The gateway's access log records each call's tokens
  under the run's id, but a log is not an interface to settle money from.

## Evidence

Measured before this was proposed for acceptance:

- **The gateway enforces a grant chosen by a credential claim, per run.** On the
  gateway release the platform runs, a route's token limit takes a list of
  fixed-size variants, each selected by a condition on the credential's claims
  and keyed by its `sub`. Runs holding the same grant keep separate counts; a
  credential with no grant falls through to the existing per-run ceiling. A list
  holds up to 64 variants, so the runtime grants from a fixed scale of sizes,
  rounding down, and a run is held to at most one step below its terms.
- **It checks before a call and charges after.** A call is admitted while the
  run's count is below its grant and charged the input and output tokens the
  provider reported, so a run overshoots its grant by at most its last call. A
  refused call answers `429` with the body the runtime already maps to
  `spend_limit`.
- **A share of balance over concurrency starves almost no batch.** Across one
  installation's batches, the median share was about eighteen times the median
  cost of an item, and fewer than one in eighty batches had a share below its
  average item cost.
