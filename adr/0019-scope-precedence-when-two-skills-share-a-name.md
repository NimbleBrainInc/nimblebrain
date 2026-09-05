# 0019. Scope precedence when two skills share a name

- Status: Proposed
- Date: 2026-09-03
- Serves: manage skills

## Context

A skill's `name` is its identity. It is what the catalog lists, what the
activation tool resolves, what delivery de-duplicates on, and what the tier merge
keys by. Names come from four independent places — the platform's own vendored
tree, a workspace's authored store, a user's own store, and a curated overlay
repo — plus a fifth, an MCP server's published skill, which is namespaced by its
publisher (ADR-0011) and so does not collide with the others by construction.

Two rules currently resolve a collision, and they are not the same rule.

`mergeScopedSkills` (`src/skills/loader.ts`) merges the filesystem tiers with
later layers overriding earlier: user beats workspace beats platform. That is
override semantics, and it is the point — a workspace tailoring the platform's
default, a user tailoring the workspace's.

`collectActivatableSkills` (`src/skills/catalog.ts`) merges the three activatable
pools with the first pool winning: filesystem, then server, then connector
overlay. That is shadowing across kinds rather than override within a tier, and
the losing entry disappears from the catalog *and* from activation resolution
*and* — because delivery dedup keys on the bare name — from the shadowed
overlay's surface-once path. One name, one skill, one delivery.

Both resolutions are silent. Nothing reports that a name was shadowed, to the
author, the operator, or the read surfaces. The plausible failure is a workspace
author naming a skill after a curated overlay and thereby muting guidance they
did not know existed.

## Options

**A. One precedence rule, stated once.** Collapse the two orderings into a
single documented chain (most-local wins) applied in one place, so the tier merge
and the pool merge cannot disagree. Leaves the silence.

**B. Keep the two rules and surface the shadowing.** Report a collision where the
author can see it: the create/update path warns, the read surfaces mark a
shadowed skill, and the load ledger records which name lost to what. Cheapest
fix for the actual failure, which is invisibility rather than the ordering.

**C. Namespace by scope, as server skills already are.** A skill's identity
becomes `<scope>:<name>`, so collisions stop existing and override becomes an
explicit act rather than an accident of naming. Cost: override was a feature —
a workspace could no longer shadow a platform default by naming a file the same
thing — so it needs a deliberate replacement.

**D. Refuse the collision.** A create or install that would shadow an existing
name fails. Loudest, and wrong for the tier case, where shadowing is exactly what
the author intends.

## What would decide it

- **Whether collisions happen.** Instrument the merges: count names dropped, by
  losing pool and winning pool, across tenants. A rate of zero settles this as
  documentation (option A) rather than machinery.
- **Which direction the collisions run.** A workspace skill shadowing a platform
  default is intended override. A workspace skill shadowing a curated overlay is
  the harmful case, and its rate is the argument for B or C specifically.
- **Whether override is used.** If no tenant relies on same-name override, option
  C is close to free. If it is a common pattern, C needs an explicit override
  declaration before it can land.
- **Whether the surface-once dedup collapse is reachable in practice** — an
  activation of the winning skill marking the shadowed overlay's name delivered.
  If it is, that is a correctness bug rather than an ergonomics question, and it
  narrows the options to those that make the shadowing visible.
