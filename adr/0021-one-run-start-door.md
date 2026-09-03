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

**The kernel constructs an engine only at its own composition root, and a run
begins only through the runtime's own entry points** — `chat` and `executeTask`
(`src/runtime/runtime.ts`), which are the two surfaces that resolve identity,
gate membership on the run's workspace, bind the tool registry for that
workspace, and resolve the run's context budget. No tool starts a run.

**A run-start door is not a principal-establishment door**, and the two are
counted separately. This ADR counts the places a *run* begins — where an engine
is constructed and a loop starts. The other count is of the places a *principal*
is established before a tool is dispatched, which includes surfaces that start no
run at all: an unattended single dispatch makes one tool call, builds no engine,
and keeps no conversation, so it adds a principal door without adding a
run-start one. A door on either axis owes the same gates; only this axis is what
"one door" here means.

**Delegation is not a kernel capability.** A sub-agent is a remote MCP server
that happens to run an agent, and calling it is an ordinary tool call — routed
through the same dispatch, subject to the same wall, the same personal-connector
grant (ADR-0006), the same permission policy, and the same audit trail as any
other tool. It earns none of the surface the kernel would otherwise pay for on
its behalf: no in-kernel run tracker, no agent-profile configuration on the
workspace record, no feature flag, no parent-run plumbing threaded through the
engine's events, the metrics labels, and the usage ledger.

`executeTask` is a second entry point, not a second door: it starts a one-shot
run rather than a conversation turn, and it performs the same gates —
notably a provenance-membership check, because an automation fires as its owner
into the workspace it was created in and membership there is validated at
create rather than per run.

## Consequences

- Every run in the system passes the same checks, and a change to those checks
  reaches every run. There is no second implementation to keep in agreement.
- A sub-agent is deployable, versionable, and reviewable like any other server,
  and it can be written by someone who does not work on this runtime.
- A sub-agent now costs a network hop and its own hosting. In-process delegation
  was cheaper on both, and that cost is the price of the boundary.
- The kernel has no notion of a run's parent. Attribution across an agent that
  called another agent is the calling tool's problem, not the ledger's.
- The two entry points share substantial setup, currently by duplication rather
  than by a shared substrate. That duplication is a maintenance cost and a place
  the two can drift; the gates themselves are the part that must not, and they
  are the part each performs explicitly.

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
