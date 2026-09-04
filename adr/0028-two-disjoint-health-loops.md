# 0028. Two disjoint health loops: process liveness and credential liveness

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

A connection stops working for two unrelated reasons, and the correct responses
are opposites.

**The transport is down.** The server restarted, the network blipped, the
upstream returned 5xx. Nothing is wrong with the tenant's authorization; the
right response is to retry, with backoff, indefinitely, because the condition is
transient by nature and self-heals.

**The authorization lapsed.** The user revoked the grant at the vendor, the
refresh token rotated out, the authorization server rejected the client. Retrying
is useless and can be harmful — it hammers an upstream that is correctly saying
no, and it can trip rate limits or lockouts. The only recovery is a human
reconnecting, and the right response is to stop and say so.

One loop that tried to handle both would need to classify every failure into one
bucket or the other, and get it right, before deciding what to do. That
classification is exactly the thing that is hard: an upstream returning 401
during an outage looks like a revoked grant, and a provider's API timing out
looks like neither.

## Decision

**Two loops, disjoint in what they watch, what they touch, and what they
conclude.**

**`HealthMonitor` (`src/tools/health-monitor.ts`) watches process liveness.** It
operates over contextless `McpSource` objects — is the transport up? — and its
only action is restart. Exponential-backoff bursts, then a slow re-probe
cooldown, and the burst budget being spent is explicitly *not* terminal: a
transient upstream outage can outlast the burst and still recover. The only
terminal state is a deliberate teardown.

**`ConnectionRevalidator` (`src/bundles/connection-revalidator.ts`) watches
credential liveness.** It operates over lifecycle connections, which carry the
`(serverName, workspace, principal, ref)` tuple a provider probe needs. It never
touches transports, never restarts, and never marks a connection dead. Its one
action is flipping a running connection to reauth-required when a provider's
probe says the upstream credential is definitively gone — and it never flips
back. Recovery is the explicit user reconnect flow, because a credential that
came back without a human doing anything is a signal to distrust.

Provider specifics live entirely behind `ConnectionHealthProbe`; the loop
dispatches by provider id and names no vendor (ADR-0026).

**The credential loop is defensive about its own conclusions**, because it is
calling an external API on a timer inside the runtime process and must degrade
nothing:

- Bounded fan-out, never a fan-out over the whole set at once.
- Jittered interval and a random startup offset — one provider key is shared
  across every tenant pod, so an unjittered sweep is a synchronized herd.
- Skip-if-still-running, so a slow sweep cannot stack.
- Per-sweep isolation, so one bad sweep never kills the timer.
- Anti-flap: N consecutive definitive verdicts before a flip. An indeterminate
  result — any API error or timeout — is a no-op that preserves the streak
  rather than resetting or advancing it; a live result resets it.
- A circuit breaker: a sweep that would flip more than a threshold aborts and
  keeps all state. A mass disappearance of credentials is far more likely an
  upstream fault than every user revoking at once.

## Consequences

- A transient outage self-heals without a human, and a revoked grant reaches a
  human instead of being retried into a rate limit.
- The two failure classes never have to be told apart at the point of failure,
  because they are watched by different things asking different questions.
- Sweep cadence is provider-agnostic and belongs to the revalidator; only the
  per-provider enable/disable is vendor config. One timer paces every provider's
  probe.
- A revoked credential is noticed within one sweep interval, not instantly. That
  is the honest cost of polling an external API rather than being told.
- The revalidator is correct at one replica per tenant, where each pod owns its
  connections' in-memory state. Running more than one replica needs leader
  election before this loop is safe, and that is a prerequisite rather than a
  tuning knob.
- Two loops means two timers, two sets of tuning, and two places to look during
  an incident. The alternative is one loop with a classifier that has to be right
  about an ambiguous signal.

## Alternatives considered

- **One loop with a failure classifier** — rejected: it puts the hardest
  judgment at the moment of least information, and being wrong in one direction
  hammers an upstream while being wrong in the other silently strands a user.
- **Auto-promoting a connection back to running when a probe says live** —
  rejected: a credential that recovered without a human acting is a signal to
  distrust, and it makes the flip a flapping state rather than a decision.
- **Treating an indeterminate probe as evidence** — rejected in either
  direction: as a credential-lost vote it turns a provider outage into a mass
  reauth event; as a reset it means a flaky provider can never accumulate a
  verdict.
