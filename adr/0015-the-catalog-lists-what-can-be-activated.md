# 0015. The catalog lists what can be activated, never what is loaded

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills

## Context

Most guidance should not be in the prompt most of the time. A skill that is
relevant to one turn in fifty is pure cost on the other forty-nine, and the
selection signals — tool globs, trigger phrases — only reach the cases an author
anticipated well enough to enumerate.

The model is the better selector when it can see what is on offer. That requires
an index: a line per activatable skill, present in the prompt, that the model
reads and activates by name.

An index in the prompt is also a hazard. The system prompt is the run's cached
prefix, and cache reads are an order of magnitude cheaper than writes. Any
section whose bytes move between turns re-writes everything after it. A catalog
that reported *state* — which skills are loaded, which have fired, how many
tokens each is costing — would move on nearly every turn, and would pay for its
usefulness by invalidating the prefix it sits in.

## Decision

**The catalog lists what CAN be activated. It never encodes what IS loaded.**

`collectActivatableSkills` (`src/skills/catalog.ts`) merges the three
activatable pools — the conversation tiers' `dynamic` skills, the focused
workspace's `dynamic` server skills, and the curated connector overlays — into
one deterministic list, and `toCatalogEntries` projects each to name plus
description and nothing else.

Determinism is by construction, not by convention:

- **De-duplicated by name**, first pool wins, in a fixed pool order (filesystem,
  then server, then connector overlay).
- **Sorted by codepoint comparison**, never locale-sensitive collation, so the
  order does not depend on the process's locale.
- **No load state, no activation state, no counts, no ordering by recency.**

The result is that the section's bytes change only when the set of activatable
skills changes — an install, an uninstall, an authoring edit — and not with the
turn. The composer classifies it as stable content for the cached prefix
(`src/prompt/compose.ts`), which is only sound because of the above.

**Collision semantics follow the same dedup.** The losing pool's skill is
shadowed out of both the catalog and the activation tool's name resolution, and
delivery dedup keys on the bare name — so activating the winner marks that name
delivered for every channel, including the shadowed overlay's surface-once path.
One name, one skill, one delivery.

Disabled skills are dropped at collection: the catalog must not offer something
an operator muted.

## Consequences

- Guidance the author could not anticipate a trigger for still reaches the model,
  because the model can read the shelf and ask.
- The catalog costs one line per activatable skill, every turn, cached. It grows
  with the number of skills installed, which is a real ceiling — a workspace with
  hundreds of skills pays for all of them to advertise themselves.
- Adding a field to a catalog entry is a decision about cache stability, not a
  cosmetic one. Anything turn-varying belongs in a different section.
- Byte-stability is a property nothing currently asserts. It follows from the
  code as written, and the code says why, but a future field could quietly break
  it.
- A name collision resolves silently in favour of the more local pool. That is
  the right default and the wrong silence — see ADR-0019.

## Alternatives considered

- **A catalog annotated with load state** ("loaded this turn", "fired 3×") —
  rejected: it is the most useful version of the section and the one that
  destroys the cached prefix it lives in. State belongs on the observability
  surfaces, which have no cache to protect.
- **Ordering by relevance or recency** — rejected for the same reason: a
  reordering is a byte change.
- **A tool the model calls to list skills** — rejected as the primary mechanism:
  it costs a round trip before the model knows anything exists, and the model
  only calls it if it already suspects there is something to find.
