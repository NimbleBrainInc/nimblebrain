# 0033. An event's family names its subject; process liveness is a connector fact

- Status: Accepted
- Date: 2026-09-06
- Serves: orchestrate remote MCP

## Context

The runtime emits facts about two different things that a reader can easily
mistake for one.

A **connector** is a URL, how to reach it, and who it speaks as. It is present in
a workspace or it is not, and the transport behind it is up or it is not.

A **connection** is narrower: one `(workspace, connector, principal)` triple
holding a credential. A workspace-scoped connector has one; a member-scoped
connector has one per active member. Its state — starting, pending auth,
running, reauth required — is a statement about that credential and that
principal, and about nothing else.

ADR-0028 keeps the two apart in code, with two loops that watch different
objects and conclude nothing about each other's question: `HealthMonitor` asks
whether a transport is up, `ConnectionRevalidator` asks whether a credential is
still good. Event names can undo that separation even when the code holds it. A
family prefix is read as a claim of kinship, so filing a transport fact next to a
credential fact invites a reader to compare them on one scale — which is exactly
the classification ADR-0028 exists to avoid having to make.

## Decision

**An event's family names the subject the event is a fact about, and every member
of a family carries that subject's identity in its payload.**

Two families follow from that:

- **`connection.*`** — a fact about one connection. Every payload names the
  triple: `wsId`, `serverName`, `principalId`. The state a `connection.*` event
  reports is the connection's own, which is to say the credential's.
- **`connector.*`** — a fact about a connector: whether it is present in a
  workspace, and whether its transport is up. Identified by the connector's
  source name. No principal, because a transport does not have one.

Process liveness is therefore a `connector.*` fact. `HealthMonitor` watches
contextless sources and its payload carries a source name and nothing more; it
has no principal to name and no connection to name one for. Presence in a
workspace is a `connector.*` fact for the same reason — an install is the
connector arriving, not a credential changing.

The verb an event uses is the operation's own name. The connector tool's actions
are `install` and `uninstall`, so the events they produce are
`connector.installed` and `connector.uninstalled`.

## Consequences

- The disjointness ADR-0028 built into the loops is visible in the log. A
  transport fact and a credential fact never share a prefix, so no reader has to
  decide whether `crashed` outranks `reauth_required`.
- The payload test is mechanical and settles new events without argument: if the
  fact cannot name a principal, it is not a `connection.*` event.
- Two families is one more than one. An operator grepping "everything about this
  connector" matches two prefixes, not one — the honest cost of not conflating
  two questions in a single prefix. Three, in fact: `source.*` is the transport
  object's report about itself, and an `McpSource` backs the platform's own
  in-process apps as well as connectors, so its subject is strictly wider than a
  connector and the family does not merge into `connector.*`.
- The rule reads back on the code that satisfies it. `HealthMonitor` enumerates
  its records by transport object, so its set is wider than the `connector.*`
  facts it emits about them. The name is right and the set is not; correcting
  the set is a behaviour change, not a rename.
- A future fact that genuinely is per-principal but is not about a credential —
  a per-member rate limit, say — lands in `connection.*` on this rule and will
  need the family's meaning widened or a third family. The rule points at the
  subject, not at credentials specifically, so it answers that when it arrives.

## Alternatives considered

- **One `connection.*` family for everything about a connector** — rejected: it
  puts the two loops' verdicts on one apparent scale and hands the reader the
  classification the loops were split to avoid.
- **A single flat family with no prefix distinction** — rejected: the subject is
  the one thing a consumer routes and filters on, so erasing it from the name
  moves that work into every consumer.
- **Keeping process liveness unnamed because it rides `run.error`** — rejected:
  the nested discriminator is a name whether or not it is a top-level event type,
  and a metric and an alert already read it.
