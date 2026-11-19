# 0072. A person turns their own skill off in one workspace, on their own record

- Status: Proposed
- Date: 2026-11-18
- Serves: manage skills; secure RBAC

## Context

ADR-0069 keeps a skill a person authors on its own in the `user` tier, where it
follows them into every workspace they belong to, because it carries guidance
and no authority. That is the right default, and it has one gap: a person who
works in several workspaces can want a skill of theirs in most of them and not
in one (a writing voice that suits their own team and not a client's).

The controls that exist do not fit. `skills__deactivate` mutes a skill for one
conversation, so the person repeats it in every chat. `set_status` writes
`status: disabled` to the skill file, which is the same file in every workspace,
so it turns the skill off everywhere. Moving the skill into each workspace that
wants it gives up "follows you" and puts a person's private guidance into a
shared partition.

The state this needs is per person, per workspace, per skill. ADR-0069 does not
place it: it adds per-workspace state to a primitive whose whole point was to
have none.

## Decision

**A person's own skill applies in every workspace they are in unless they turn
it off in a workspace. The off belongs to the person and is stored on their
record.**

- **Where it lives.** `users/<userId>/skills-off.json` maps a workspace id to
  the skill names off there. It is never in the workspace's partition, so no
  other member can read it, and an entry for one workspace touches no other.
- **What it keys on.** The skill's manifest name, the key the tiers merge on
  (ADR-0019) and conversation mutes use (ADR-0034).
- **Where it applies.** Where the `user` tier is collected for a run
  (`Runtime.loadConversationSkills`), before the merge. Every run in that
  workspace — a chat, a task, which runs as its owner — collects the tier
  without the skill, so it leaves the always-on channel, the catalog, bound
  delivery, and the trigger matcher together. Because the skill is gone before
  the merge, a same-named workspace or org skill wins that workspace
  (ADR-0019).
- **Cache.** The catalog's bytes move once when the switch flips, as an
  authoring edit moves them, and not with the turn (ADR-0015, ADR-0018).
- **Who sets it.** Only the owner, through `skills__set_here`, an app-only tool
  as `set_status` is: it is a durable setting, decided on the surface that shows
  it. The model's control stays the per-conversation mute.
- **What it covers.** `user`-tier skills only. A workspace or org skill is
  changed by its owner, and a personal plugin's skills reach a workspace by
  grant (ADR-0069), not through this list.
- **Lifetime.** Deleting the skill clears its entries, so a new skill of that
  name starts on everywhere.

The `user`-scope listing reports `onHere` for the workspace it is called in, so
a client shows the switch from the listing it already reads.

## Consequences

- One sentence explains reach: your skills go everywhere you go, except where
  you turned one off.
- A run pays one small file read per collection of the `user` tier.
- An unfiltered `skills__list` shows what conversations in the workspace load,
  so an off skill is absent there; the `user`-scope listing keeps it with
  `onHere: false`.
- Renaming a skill is a delete and a create, so its offs do not carry over.
- Entries for a workspace the person has left stay on their record and act on
  nothing.

## Alternatives considered

- **A field on `skills__update`.** `update` edits the skill file, which is the
  same in every workspace, snapshots it, and is called with no workspace for a
  `user` skill. This is not file content and needs a workspace.
- **Store the off in the workspace.** Other members, and the workspace's admins,
  would see a member's private setting, and deleting the workspace would be the
  only way it ends.
- **An opt-in list (on only where named).** It reverses ADR-0069's default, and
  every new workspace would start without the person's skills.
