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
  the door reserves from each account the run names the most the run could
  spend (its ceiling, or the account's balance if lower), grants the least of
  those reservations and the run's cap, and holds the reservations until the run
  ends. It then debits what the run spent and releases the rest. The ledger stays
  the runtime's, and no other process reads or writes it.
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
- A run on a shared account holds its whole reservation for its whole run, so
  concurrent runs on one account start with less, and a run may stop with
  balance left that another run held.
- The gateway cannot shrink a call to what is left, so a run can overrun its
  grant by the output of its last call. The native engine keeps its exact clamp.
- Settlement needs what the run spent, and an agent's report of its own usage is
  not trusted to decide that: an agent that under-reports would return spend to
  the account it never released. Settlement reads the gateway's count for the
  run. Until that count is readable, the runtime debits the whole grant of a run
  on an external runtime, which overcharges a run that stopped early and never
  undercharges one.

## Open before acceptance

- Whether the gateway can select a fixed limit by a credential claim and key it
  by run, in the release the platform runs, or needs the amount itself to come
  from the claim (an upstream change).
- How the runtime reads the gateway's count for one run (its access log carries
  the run id and each call's tokens).
- How much reservations starve concurrent runs on a batch's shared account.
