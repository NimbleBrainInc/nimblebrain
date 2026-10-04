# 0047. The door decides a run, and an execution provider runs it

- Status: Proposed
- Date: 2026-10-04
- Serves: orchestrate remote MCP, secure RBAC

## Context

`Runtime.startRun` is the one door every agent run passes (ADR-0021). It resolves
what a run may be: the workspace, the membership check, the composed prompt, the
walled tool set, the model, the limits, and, for an unattended run, admission and
spend (ADR-0045). It then runs the engine loop in the runtime's own process.

Running the loop in-process ties an unattended run's life to that process. A
restart or rollout ends every run in flight, the admission queue is held in
memory, and a batch's width is bounded by the runtime's own CPU and memory rather
than by its budget. A durable job service can run work in isolated jobs that
survive the runtime and scale on their own. Moving the loop there is attractive,
and it is also where every guarantee the door makes could quietly stop holding.

Each of those guarantees lives somewhere a remote loop would not be:

- **The unattended policy and the tool set** are carried by the in-process run.
  Its request context is stamped unattended, and its router is bounded by the
  run's allowed tools. A request arriving at `/mcp` builds its own context from
  the caller's identity and workspace, so a remote loop calling back through it
  would get the attended surface, authoring tools included.
- **Spend** is checked by the door before each model call, against balances it
  holds, with a reservation per call (ADR-0045). A loop that calls the model
  itself checks its own spend, so nothing stops it from exceeding what the run
  was granted, and it needs a model key, which is a stored secret.
- **Credentials** are held in the runtime's store and used where they are stored.
  Shipping them with a run puts every secret the run touches outside the store
  and outside the wall.
- **Admission** is door state. A second queue anywhere else is a second ordering
  that fair share cannot see.

## Decision

**The door decides a run; an execution provider runs it.** The door resolves a
run into a **resolved run specification**: the system prompt it composed, the
walled tool list (names and schemas), the model, the per-run limits, and the
run's spend accounts. It hands that specification to the configured execution
provider, which runs the engine loop and reports the outcome. A provider may
narrow what the specification allows and may never widen it, which is what keeps
it from being a second door. Which provider runs a run is installation
configuration, never the task author's choice.

**In-process is the default and the reference.** The runtime ships the
in-process provider, which runs the loop as today and needs nothing else. An
installation with no other provider runs every run with it. A conformance suite
runs the same specifications against every provider and requires the same
outcomes, so a remote provider is held to the in-process behavior, not to its own
description of it.

**A remote provider receives a specification and one run-scoped credential,
nothing else.** The runtime mints the credential with a key of its own (not the
platform's signing key), when the run starts rather than when it is queued. Its
audience is that one run, it expires with the run's maximum duration, and it is
revoked when the run ends. The runtime both mints and verifies it. The provider
holds no stored secret, no connector credential, and no model key.

**Tool calls come back through `/mcp`, bounded by the run.** `/mcp` recognizes a
run-scoped credential and, instead of building an attended context, reads the
run's stored specification and applies its bounds: the request context is
unattended, the router is limited to the specification's tool list, and every
call dispatches under the owner's identity through the same wall, consent and
unattended policy as an in-process run. The credentials those tools need are used
where they are stored.

**Model calls come back through a runtime-hosted model endpoint.** The provider
sends each model call to the runtime with the run credential. The door's spend
check runs before the call, with the same reservation and settlement as an
in-process call, and the usage ledger records it. Admission and spend therefore
stay at the door whichever provider runs the loop.

**The run's activity and usage come back through those same paths**, so the
source that started the run writes its run record exactly as it does for an
in-process run.

**There is one queue, at the door.** A run waits in the door's admission queue
and is handed to a provider only when it holds a slot. The provider never queues.

**A restart reconciles from durable state.** The specification is stored beside
the run record when the run starts. On boot, the source re-enqueues queued run
records it may resume, asks the provider for the status of runs it recorded as
running, and, before authorizing any callback from one of those, rewrites the
remaining amount on its stored spend accounts from the usage ledger, so the first
call after a restart seeds the door's balance from current spend.

## Consequences

- A remote run survives a runtime restart, and a batch's width becomes a budget
  decision rather than a limit of the runtime's process. Nothing the door decides
  moves out of the runtime to get there.
- Every tool and model call of a remote run is a network round trip to the
  runtime. A short run may finish faster in-process, and the runtime serves those
  calls, so its load grows with the provider's concurrency even though the loop
  runs elsewhere.
- `/mcp` gains a second kind of caller: a run, not a person. Its context is
  derived from a stored specification rather than from a session, and a gap in
  that derivation is a gap in the wall, so the conformance suite exercises the
  callback path, not only the loop.
- The runtime gains a key it mints run credentials with, and that key needs the
  storage and rotation any signing key needs.
- A provider that cannot satisfy the conformance suite is not a provider. That
  includes any that would need a credential or a model key shipped to it.
- The in-process provider stays the only one an installation without a job
  service ever sees, and nothing in this decision changes how it behaves.

## Alternatives considered

- **Shipping the credentials a run needs with its specification** — rejected:
  every secret a run touches would leave the store and the wall.
- **The provider holding a model key** — rejected: spend would be checked where
  it is spent, by the party that wants to spend it, and the key is a stored
  secret.
- **A queue in the provider** — rejected: a second ordering of waiting runs that
  admission and fair share cannot see, and a run token ageing while it waits.
- **The provider deciding what a run may do** — rejected: that is a second
  run-start door (ADR-0021).
- **Callbacks through `/mcp` with the caller's ordinary credential** — rejected:
  the callback would get the attended surface and the user's full reach, not the
  run's.
