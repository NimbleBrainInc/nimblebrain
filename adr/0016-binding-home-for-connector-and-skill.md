# 0016. Where the connector↔skill binding lives

- Status: Proposed
- Date: 2026-09-03
- Serves: manage skills, orchestrate remote MCP

## Context

Three mechanisms currently associate guidance with a connector, and they bind in
three different places.

A **server-published skill** (ADR-0011) needs no binding at all: the skill is a
resource on the server, so the association is the fact of publication, and the
tool-affinity glob the adapter stamps is derived from the source's own name.

A **curated overlay** (ADR-0013) binds by *identity string*. The overlay repo is
keyed `<identity>/SKILL.md`, and the identity is derived at install by
`connectorSkillIdentity` (`src/connectors/server-detail.ts`) — the brokered
toolkit slug when the catalog entry names one, otherwise the last dotted segment
of the reverse-DNS server name's first path component. The materialized copy is
then re-stamped with a tool-affinity glob bound to *that install's* namespace.

An **authored skill** binds by whatever `tool-affinity` globs its author typed.

So the same relationship — this guidance is about that connector — is expressed
as a derived string in one place, a namespace glob in another, and an implicit
publication fact in a third. The derivation is the fragile one: it is a formula
over a name, it can collide across unrelated connectors that happen to share a
last segment, and a connector whose name does not follow the shape it assumes
resolves to an identity no overlay is keyed under. The failure is a silent 404,
which is indistinguishable from "no overlay is curated for this connector."

## Options

**A. Keep the derived identity, and make the derivation the documented contract.**
Cheapest. The overlay repo stays keyed by a string the runtime computes, and the
rule becomes part of what a curated overlay author must know. Every miss is
still a silent no-op.

**B. Name the overlay on the operator-published catalog entry.** The entry
already carries operator-trusted, server-declared host metadata for
`ui`, `hooks`, and the notifications outbox (`src/registries/projection.ts`).
An overlay reference would sit beside them, and the install would read a name
rather than compute one. Cost: one more hand-maintained field per entry, and a
second place a curated overlay's existence is recorded.

**C. Bind from the skill.** The overlay declares which connectors it applies to,
so the association lives with the guidance rather than with the connector. Cost:
the curated repo becomes the source of truth for a relationship the catalog also
describes, and the lookup direction inverts — the install can no longer ask for
one file by name.

**D. No binding field; make the referent visible.** Fold the guidance into the
catalog line the model already reads (ADR-0015) and let the model resolve which
guidance applies to what it is doing. Cost: guidance the model does not think to
ask for never arrives, and the surface-once delivery guarantee has nothing to key
on.

## What would decide it

- **How often the derived identity actually misses.** Count installs whose
  identity resolves to no curated overlay, split by whether an overlay for that
  connector exists under a different key. A derivation with no observed misses is
  not worth replacing; one that misses on a class of names is.
- **Whether collisions are reachable.** Two catalog entries whose derived
  identities are equal, one of which has an overlay. If the catalogue can produce
  that pair, the derivation is a correctness bug rather than an ergonomics one.
- **Whether the model resolves guidance from a visible referent.** Option D
  stands or falls on measurement: with the guidance named in the catalog and no
  binding metadata, does the model activate it on the turns where it helps? Only
  a negative result justifies adding a relationship field.
- **How many overlays exist.** Options B and C both add a hand-maintained copy of
  the relationship. At a handful of overlays that is nothing; at a hundred it is a
  second catalogue that drifts.

Until then, the derived identity stands and its failure mode — a silent 404
treated as "not curated" — is a known cost, not an accepted design.
