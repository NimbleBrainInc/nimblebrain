# 0034. A skill's scope names where it is stored; its name prefix names who published it

- Status: Accepted
- Date: 2026-09-07
- Serves: manage skills

## Context

Two labels ride on every skill the runtime composes, and they answer different
questions.

`SkillManifest.scope` answers **where the document lives and who may write it**.
Three of its members name a directory tier under the work dir — `org`,
`workspace`, `user` — and every mutation gate reads the union to decide whether
an edit is even possible (`assertSymlinkBoundaryOrThrow` uses it as the
outside-the-work-dir sentinel; the mutation tools refuse a scope that names no
writable tier). The scope is stamped at load from the path a skill was read
from. It is absent from the on-disk frontmatter schema and the writer refuses to
serialize it (ADR-0012 depends on that for the vendored marker), so no file
declares its own tier and no third party can claim one.

The fourth member has to cover everything that is not one of those three
directories: a skill vendored with the platform image, and a skill synthesized
from a server's `skill://…/SKILL.md` resource, which has no file at all
(ADR-0011). What those two share is not an origin — one is first-party and one
is arbitrary third-party content — but a storage fact: neither is stored where
this instance authors skills, so neither can be edited here.

A **connector overlay** (ADR-0013) carries a different label for a different
purpose. `CONNECTOR_SKILL_SCOPE` tags a materialized overlay candidate with the
connector it is bound to. It is not a member of `SkillScope` and never enters
the authored-skill tiers, because an overlay is not an authored skill.

Separately, a **server-published skill's manifest name is prefixed**, because
the manifest name is the de-duplication identity and two servers may both
publish a skill called `usage`. That prefix answers a third question — who
published this — using a character the on-disk name pattern forbids, so a name
carrying it can only have been built by the adapter.

Naming any two of these three after the same thing merges concepts the runtime
deliberately keeps apart. Naming one for its host and one for its origin leaves
a reader unable to tell which question a given label answers.

## Decision

**A skill's scope names where it is stored. A skill's name prefix names who
published it. A connector overlay's scope names the connector it is bound to.**

`SkillScope` is `org | workspace | user | provided`. The first three are the
writable directory tiers under the work dir. `provided` is everything outside
them — provided to this instance rather than authored in it, and read-only by
construction. It carries no claim about trust: a `provided` skill may be the
platform's own scaffolding or an arbitrary server's, and the prompt composer
separates those on `provenance.origin`, never on scope (ADR-0012).

`CONNECTOR_SKILL_SCOPE` stays `connector` and stays outside the `SkillScope`
union.

A server-published skill's manifest name is `connector:<connector>:<skill>`.

**A recorded conversation event is a record, not state.** The runtime does not
rewrite one to match a later vocabulary, and no reader is taught a second
spelling to make an old one match. A value in a recorded event is read only by
surfaces that display what a past turn did.

## Consequences

- A reader can tell the three labels apart without a comment: a tier, a
  publisher, a binding. `provided` and `connector` sit on different fields and
  answer different questions, so neither is available to absorb the other.
- The trust decision and the mutability decision stay on separate fields.
  `provided` says only "not editable here"; whether a body renders as
  first-party identity or inside third-party containment stays on
  `provenance.origin`, which a file cannot declare.
- **A conversation-scoped mute keys on the skill's manifest name, so any change
  to how that name is built ends the mutes standing under the old identity.**
  The muted skill composes again from the next turn, and the operator's remedy
  is to mute it again. Delivery dedup (`skill.activated`) keys on the same name,
  so a body already delivered under an old identity is delivered once more.
  Because the record cannot be rewritten and the comparator will not read two
  spellings, this cost is paid, stated in the release notes, and not hidden.
- A display surface that maps the scope union to a label is a partial function
  over what a historical record may hold, so it falls back to the stored string
  rather than rendering nothing.
- Nothing about the scope is migrable, and nothing needs to be: it exists on
  disk nowhere.

## Alternatives considered

- **Folding the published-skill tier into the overlay scope** — rejected: it
  merges a storage tier with a connector binding, and the mutation gates that
  read the union would then also match a candidate that never had a file.
- **Naming the fourth tier for the platform (`system`, `builtin`)** — rejected:
  an arbitrary server's guidance carries it too, and the composer reads that
  same value to decide third-party containment. The name would contradict the
  decision made three lines below it.
- **Naming it for the trust posture (`vendored`)** — rejected: `vendored` is the
  unforgeable provenance marker (ADR-0012), and a third party's skill carries
  this scope.
- **Teaching the mute comparator both spellings** — rejected: a compatibility
  read has no end condition, and it would put the runtime's identity rules
  permanently in service of a record nothing reads for behaviour.
- **Rewriting recorded conversation events** — rejected: append-only history is
  a record of what happened. Editing it to fix a label is not a migration.
