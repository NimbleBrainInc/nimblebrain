# 0067. The gateway counts a run on one replica and holds it to its whole grant

- Status: Accepted
- Date: 2026-11-18
- Serves: orchestrate remote MCP
- Amends: [ADR-0063](./0063-a-runs-model-credential-carries-the-spend-it-is-allowed.md) (how the gateway approximates a grant)

## Context

ADR-0063 has the runtime write the most a run may spend into its model
credential as a grant, and the gateway refuse the run's calls once its spend
reaches it. The gateway keeps each run's count in the memory of the replica that
serves the call, so a run whose calls reach several replicas has a count on
each. ADR-0063 had the gateway hold a run to the grant divided by its replica
count, so that the counts together never pass the grant.

That division assumes a run's calls spread evenly over the replicas. A client
holds its connections open and reuses them, so a run's calls reach one replica
far more often than several. Such a run is held to its grant divided by the
replica count: a run with a cap of its own stops at a fraction of it, reported
as having reached its cap, and where it stops depends on which replica served
its calls rather than on what it spent.

## Decision

The gateway counts each run on one replica and holds it to its whole grant.

- **A caller is pinned to one replica.** The gateway's service sends every
  connection from one client address to the same replica. A run executes in one
  pod, so one replica serves and counts its calls.
- **The limit is the grant, not a share of it.** The gateway holds the run to the
  largest of its limits at or below the grant; the replica count plays no part.
  A grant below its smallest limit, or a claim that is not a whole number, still
  admits one call.

The rest of ADR-0063 stands: the runtime states the true grant and knows nothing
of the gateway's replicas or limits, the gateway counts input and output tokens
together, and the grant is an admission threshold.

## Consequences

- A run with a cap is held at its cap, at most one of the gateway's limit steps
  below it, whichever replica serves it.
- A run can now pass its grant by more than its last call when its count is
  split: a replica that restarts or leaves mid-run takes its count with it, and
  the run starts a new count on another; calls made for the run from a second
  pod are counted apart. Both are bounded by one grant per split. ADR-0063's
  "below its terms, never above them" becomes "at its terms, above them only
  when its count is split".
- Load spreads across the gateway's replicas by caller, not by call, so a
  replica can carry more of the traffic than another. The gateway's per-call
  work is small next to the model call it forwards.

## Alternatives considered

- Keep dividing by the replica count: holds every run that reaches one replica
  to a fraction of its terms, which is most runs.
- Keep the count in a store the replicas share: exact whichever replica serves a
  call, but adds a service in the path of every model call. That is an open
  decision, not one this record makes: the proposal in #2015 takes a shared count,
  with grants in money, and would supersede this record if accepted. Until then,
  pinning gives one replica the whole count without the new dependency.
- Run one gateway replica: exact, but gives up serving through a pod restart.
