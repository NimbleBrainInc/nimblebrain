# 0019. The most local skill wins a shared name

- Status: Accepted
- Date: 2026-09-03
- Serves: manage skills

## Context

A skill's `name` is its identity. It is what the catalog lists, what the
activation tool resolves, what delivery de-duplicates on, and what the tier merge
keys by. Names come from independent places: the platform's own vendored tree
and the org's store, a workspace's authored store, a user's own store, an MCP
server's published skills (ADR-0011), and a curated overlay repo (ADR-0013).

Two merges resolve a collision, at different points.

`mergeScopedSkills` (`src/skills/loader.ts`) merges the filesystem tiers with
later layers overriding earlier: user beats workspace beats the platform and org
pool. That is override semantics, and it is the point — a workspace tailoring
the platform's default, a user tailoring the workspace's.

`collectActivatableSkills` (`src/skills/catalog.ts`) merges the three activatable
pools with the first pool winning: filesystem, then server, then connector
overlay. That is shadowing across kinds rather than override within a tier, and
the losing entry disappears from the catalog *and* from activation resolution
*and* — because delivery dedup keys on the bare name — from the shadowed
overlay's delivery before its tool's first call (ADR-0053). One name, one skill, one delivery.

Both resolutions are silent. Nothing reports that a name was shadowed, to the
author, the operator, or the read surfaces. The plausible failure is a workspace
author naming a skill after a curated overlay and thereby muting guidance they
did not know existed.

## Decision

**One precedence chain: the more local source wins a shared name.**
From winner to loser: user, workspace, the platform and org pool, a
server-published skill, a curated overlay. A tenant's own authoring beats a
vendor's, and a narrower scope beats a wider one.

`mergeScopedSkills` applies the chain across the filesystem tiers;
`collectActivatableSkills` applies it across kinds, with the merged filesystem
pool first. `collectActivatableSkills` states that its order matches
`mergeScopedSkills`. The losing skill leaves the catalog, `nb__use_skill`
resolution and delivery: one name, one skill, one delivery.

The shadowing stays silent. The deciding test was whether collisions happen:
counting same-name skills across tiers found none, so the rule is documented
rather than given machinery.

## Consequences

- A workspace or user can tailor a platform default by naming a skill the same
  thing. That override is the point of the tier order.
- A workspace skill named after a curated overlay mutes that overlay, and nothing
  says so. If collisions start to occur, surfacing them (the first alternative
  below) is the next step, not a change to the order.
- A merge added later must keep the same direction, or the catalog and activation
  disagree about which skill a name means.

## Alternatives considered

- **Keep both orders and surface the shadowing** (warn on create, mark the
  shadowed skill, record it in the load ledger) — deferred: it fixes invisibility,
  and with no collisions there is nothing to make visible.
- **Namespace by scope** (`<scope>:<name>`) — rejected: it removes same-name
  override, which tiers rely on, and needs an explicit override declaration in its
  place.
- **Refuse the collision** — rejected: wrong for the tier case, where shadowing is
  what the author intends.
