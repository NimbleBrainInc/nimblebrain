# 0021. One run-start door; delegation is not a kernel capability

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP, secure RBAC

## Context

Starting a run is where every authorization decision in this system is made.
Which workspace the session reaches (ADR-0001), whether the caller is still a
member of it (ADR-0007), which tools the shape of a name lets it address
(ADR-0005), which model it may use, and what context budget it gets — all of it
is resolved once, at the top, and everything downstream inherits the answer.

That makes run-start a chokepoint, and a chokepoint is only worth having if there
is one of it. A second place that constructs an engine and starts a run
necessarily re-derives those answers, or inherits them from a caller. Either way
the wall stops holding by construction and starts holding by review — and review
is a property of the last person to read the file, not of the code.

A sub-agent is the tempting exception. It looks like something the kernel should
offer: the same engine, a fresh context, a narrower toolset. But it is a
capability, and the runtime's whole thesis is that capabilities arrive as MCP
servers.

## Decision

**One door establishes every agent run, and everything that wakes the agent
describes its run to that door rather than building one.** `Runtime.startRun`
(`src/runtime/runtime.ts`) owns what every run needs regardless of what triggered
it: the membership re-check for the workspace the run acts in, the active tool
set and the prompt composed over it, the model's budgets, the event-sink chain,
the engine, and the request context it runs under. A trigger — a chat turn, a
cron tick, an operator's manual run, an embedded caller — supplies a
specification and gets a handle back. No tool starts a run.

What the door deliberately does **not** own is what a caller's own resource
means: resolving a conversation, returning its id, generating a title,
persisting a run result. Those stay with the caller that has a resource to keep,
which is what lets the door be one door without becoming everything.

**A run-start door is not a principal-establishment door.** This ADR is about
where a *run* is established — an engine and a loop. A separate question is
where a *principal* is established before a tool is dispatched, and that
includes surfaces which start no run at all: an unattended single dispatch makes
one tool call, builds no engine, and keeps no conversation, so it is a door on
the second axis and not on this one. Both axes owe the same gates for the same
reason; only the first is what "one door" means here.

**Delegation is not a kernel capability.** A sub-agent is a remote MCP server
that happens to run an agent, and calling it is an ordinary tool call — routed
through the same dispatch, subject to the same wall, the same personal-connector
grant (ADR-0006), the same permission policy, and the same audit trail as any
other tool. It earns none of the surface the kernel would otherwise pay for on
its behalf: no in-kernel run tracker, no agent-profile configuration on the
workspace record, no feature flag, no parent-run plumbing threaded through the
engine's events, the metrics labels, and the usage ledger.

The gates are asserted at the door, not by each caller, and the membership
re-check is the one that shows why that matters. A run that *continues*
something established earlier — a resumed conversation, an automation authored
weeks ago — was membership-validated when that thing was created, and creation
time is precisely the check that goes stale. Asserting it once at the door means
a since-removed owner stops acting immediately, on every path, including paths
that do not exist yet (ADR-0007). Callers differ only in how they render the
refusal: the scheduler classifies it as skipped rather than failed, so an
automation self-heals if its owner is re-added.

## Consequences

- Every run in the system passes the same checks, and a change to those checks
  reaches every run. There is no second implementation to keep in agreement.
- A sub-agent is deployable, versionable, and reviewable like any other server,
  and it can be written by someone who does not work on this runtime.
- A sub-agent now costs a network hop and its own hosting. In-process delegation
  was cheaper on both, and that cost is the price of the boundary.
- The kernel has no notion of a run's parent. Attribution across an agent that
  called another agent is the calling tool's problem, not the ledger's.
- An invariant asserted at the door holds for every way of waking the agent,
  including ways not yet written. Two callers each re-implementing it would hold
  it only until the third forgot — which is the same argument this ADR makes
  against a `delegate` tool that re-runs the gates itself, applied to the
  runtime's own callers rather than to a tool.

## Alternatives considered

- **A kernel `delegate` tool that reuses the parent's request context** —
  rejected: it is a run-start that skips the door, and inheriting a context is
  precisely how a check that was made for one purpose gets relied on for another.
- **A kernel `delegate` tool that re-runs every gate itself** — rejected: it is
  then a second implementation of the door, which must never be wrong, and which
  nothing forces to stay in step with the first.
- **A privileged in-process sub-agent source** — rejected: "in-process" is the
  trust boundary the platform's own sources sit on (ADR-0014, ADR-0022), and
  putting tenant-configurable agent behaviour inside it dissolves what that
  boundary means.
