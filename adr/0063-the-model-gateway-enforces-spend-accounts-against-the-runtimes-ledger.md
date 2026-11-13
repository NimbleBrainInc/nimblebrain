# 0063. The model gateway enforces spend accounts against the runtime's ledger

- Status: Proposed
- Date: 2026-11-12
- Serves: orchestrate remote MCP
- Amends: [ADR-0045](./0045-a-task-is-the-unattended-primitive-and-its-trigger-is-optional.md) (where a run's spend accounts are checked), [ADR-0062](./0062-a-run-executes-on-the-default-runtime-only-when-it-can-hold-the-run.md) (which runtimes hold a run with spend accounts)

## Context

A run's spend accounts (ADR-0045) and its run-wide input-token cap are checked
before each model call by the native engine's spend gate, against balances the
runtime holds. An external agent runs its own loop and calls the model gateway
itself, so the runtime never sees its calls, and ADR-0062 sends every run with
an account or a cap to the native engine. External runtimes therefore never run
budgeted work.

Two other places could check those calls. The agent could check them itself,
but that asks the party being budgeted to enforce its own budget, and asks every
ACP agent to implement a NimbleBrain protocol ACP does not have. The model
gateway is the other: with `execution.modelGateway` set, every model call on
every runtime crosses it, it already verifies the run's credential, and it
already settles a per-run token budget with the usage each response reports.
That budget is a fixed ceiling counted separately on each gateway replica, so it
bounds a runaway run but cannot hold an account that several runs share or that
differs per run.

The gateway speaks the Envoy rate-limit service protocol: before a call it asks
a rate-limit service whether a descriptor may proceed, and after the response it
charges the tokens the provider reported. The runtime's ledger already answers
the same two questions for the native engine: may this call start, and what did
it cost.

## Decision

The runtime serves its spend ledger to the installation's model gateway as an
Envoy rate-limit service, and the gateway consults it on every model call.

- **The descriptor is the run, never an account.** The gateway sends the run id
  from the run credential it already verified (`sub`). The runtime looks up the
  accounts the run holds; account ids and balances never leave the runtime, so
  the credential carries nothing new and no caller can name an account.
- **One debit per call.** A call made inside a run whose runtime has its own
  spend gate is answered OK and charged nothing at the gateway, since the engine
  already reserves and debits it. Every other call is checked before it starts
  and debited with the reported usage after it ends.
- **Fail closed.** If the ledger does not answer, the gateway refuses the call.
  The ledger lives in the runtime, which every run depends on already: a runtime
  that is down has no run to serve.
- **The ledger is reachable only from the gateway.** The runtime serves it on
  its own port, admitted by network policy from the gateway's namespace alone.
  It adds no key and no audience: the run id it receives was verified by the
  gateway, and the worst a forged request could do is stop a run early.
- **A runtime that reaches models only through such a gateway holds spend
  accounts.** ADR-0062's routing then keeps those runs on the default runtime.

The gateway's fixed per-run budget stays, as the backstop against a runaway run
when no account is named.

## Consequences

- Budgeted and capped work runs on external runtimes, with no change to any
  agent, and a third-party agent in the worker pool is held to the same budget.
- The bound is weaker than the native engine's. The gateway cannot shrink a
  call's output to what the balance can pay for, so a call that starts with a
  positive balance completes and may overrun it by its own output; each
  concurrent run can overrun by at most one call. The native engine keeps its
  exact clamp.
- The gateway gains a dependency on the runtime it did not have: it no longer
  serves model calls while the runtime is unreachable.
- The ledger stays in one runtime process, so this adds to what blocks running
  more than one replica, and moves with the answer to that.
- `usd` accounts are priced by the runtime from the usage the gateway reports and
  the model the call named, as the engine prices them.

## Open before acceptance

- What token count the gateway sends on the response-time charge (input, output,
  or their sum), since an `input_tokens` account must be debited with input
  alone.
- Whether that charge reaches the rate-limit service for a streamed response,
  and on a cancelled one.
- The extra round trip's latency on a batch that makes many calls in parallel.
