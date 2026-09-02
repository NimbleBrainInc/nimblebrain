# 0008. Notifications are pulled into a workspace inbox and routed by the operator

- Status: Accepted
- Date: 2026-09-02
- Serves: orchestrate remote MCP, secure RBAC

## Context

An MCP server learns things nobody asked it for: a domain it ordered goes
active, a reply lands on a campaign. Nothing is calling the server when it finds
out, and the two existing channels do not carry the fact. A tool result exists
only while the agent is mid-call; the briefing facet is a summary the dashboard
pulls on load, with no identity per item, no cursor, and no way to reach anyone.
MCP itself has no answer either: in every revision, what a server emits reaches
a client only over a stream that client is holding, and its durable primitive
for "the call you made is still running" is a Task, not a channel for unsolicited
facts.

So each server that wants to tell a human something has to grow its own Slack
client, its own credential, and its own idea of who the human is — which is the
tenant isolation model inverted, because a shared service would be originating a
workspace claim rather than verifying one.

## Decision

**A server records, the runtime moves and holds, and a connector delivers.** Each
of the three has one job and none has to know the other two exist.

A server that has something to say writes an envelope into its own store and
exposes that store as one MCP resource, an outbox it declares in its host
manifest. The runtime reads that resource on its own schedule through the
ordinary MCP path, and writes every envelope, durably and first, into an inbox
owned by the workspace whose connector produced it. The inbox is the guarantee:
the web shell renders it live and replays it over a list endpoint, and the agent
reads it through a tool. Everything past the inbox is best-effort. Delivery to a
human is a route — operator configuration on the workspace record naming a
deterministic tool call on a connector the workspace already installed. The
runtime grows no SMTP, Slack, or WhatsApp client.

Two rules hold the design up.

**The runtime reads the standard envelope fields and its own `_meta` block, and
never `data`.** The envelope is the runtime's own shape, so unlike a vendor
webhook body it may be read — but only the parts the runtime defined: the event
id, name, timestamp, and the presentation block it renders and matches on.
`data` is the server's structured payload, forwarded verbatim and interpreted by
nobody in the kernel. The moment runtime code reads a field out of it, the host
has started knowing what one server's events mean, and the split that makes a
third-party server's outbox work identically to a first-party one has failed.

**A route's principal is its author.** A route fires as the workspace admin who
wrote it, stamped from the authenticated context at write time and never
configurable, so it passes through the same permission gate, personal-connector
grant (ADR-0006) and audit trail a session does. An admin naming another user
would be impersonation, and a route acting as the platform would be ambient
authority that survives offboarding — instead, an author who is no longer a
member has their route skipped and self-healing on re-add (ADR-0007).

## Consequences

- The runtime holds one notification model rather than one per vendor, and a
  new delivery channel costs an MCP server rather than a kernel PR.
- A server never learns the runtime's address, mints nothing, and stores nothing
  about the platform. It is readable by any host that speaks MCP.
- The inbox is workspace-owned and path-authoritative (ADR-0003), so no read
  crosses the wall (ADR-0005) and a workspace delete takes its notifications
  with it. It carries no owner sub-partition: a notification is authored by a
  connector, so any member who can reach that connector's tools can read it.
- Latency is one poll interval, not one network hop. That is the honest cost of
  the runtime pacing its own load, and it rules this out for sub-second cases.
- Server-authored text now reaches a human's attention surface. What governs it
  is the route and the per-source level ceiling, not the shape of the envelope,
  so the envelope carries no tool name and no action a UI would render as an
  affordance.

## Alternatives considered

- **A push door mirroring the inbound hooks door** — rejected as the transport:
  under push a server chooses when to spend the runtime's cycles, and a tenant
  runtime is one pod, so one server's bug wakes every tenant at once; a door that
  persists-before-acks and retries becomes the queue and the bus inside the
  kernel within a few iterations. Reserved as a bodyless "poll now" hint if a
  sub-minute case ever appears.
- **Runtime-side senders (SMTP, a Slack SDK, Twilio)** — rejected: a Slack client
  serves none of the three golden rules, duplicates credentials the workspace
  already holds in its connectors, and makes every new channel a kernel change.
  Delivery as a tool call gets Slack, mail, SMS and WhatsApp with no kernel code
  per channel, and inherits the wall and offboarding revocation for free.
- **A cluster event bus (Argo Events, Knative, NATS)** — rejected: their triggers
  are cluster-credentialed, and a tenant's Slack is a connection inside that
  tenant's workspace, revocable on offboarding. Respecting that would mean
  re-implementing this runtime's authorization inside the bus. The decomposition
  is worth borrowing and is: the declared outbox is the source, the inbox is the
  bus, a route's match is the sensor, and its delivery target is the trigger.
