# 0054. Guidance for one app is a skill bound to its tools

- Status: Accepted
- Date: 2026-10-19
- Serves: manage skills

## Context

A workspace often wants the agent to follow its own rules when it uses one app:
how the team uses a CRM's stages, a voice for what a document tool writes. That
guidance is the workspace's, not the app author's.

The kernel already has the primitive for it. A skill with `tool-affinity` reaches
the model before its tools' first call in a conversation (ADR-0053), on the same
call as the connector's own skill, and costs nothing on a turn that never touches
those tools. A workspace skill is host-owned: stored at the workspace's scope,
edited in Skills settings, versioned, and audited. An always-on skill covers
guidance that must hold before any tool is chosen.

A second channel for the same guidance would have the host read a fixed resource
from every connector on every prompt assembly, so the connector stores
workspace-owned text and the host pays a round trip per connector per run to find
out whether it has any.

## Decision

Guidance a workspace sets for one app is a workspace skill whose `tool-affinity`
matches that app's tools. The host reads no instructions resource from a
connector. What a connector's author wants every workspace to know is the
connector's own guidance: its `instructions` and the skills it publishes.

The host reserves no resource scheme for app guidance.

## Consequences

- One place holds a workspace's guidance, under the skill scopes ADR-0034 names,
  with the skill system's loading rules, history and audit.
- Prompt assembly makes no per-connector instructions read. Its remaining connector
  read is the resource-template list, which each connection memoizes.
- A connector that publishes instructions as a resource is not refused; the host
  does not read it. Its text reaches the agent only once someone moves it into a
  skill.

## Alternatives considered

- **A fixed resource every connector may publish, read on each assembly** —
  rejected: a second home for skill-shaped guidance, stored by the connector, at
  a read per connector per run whether or not it publishes one.
- **The same resource, cached per connection** — rejected: removes the cost, keeps
  the second channel.
