# 0007. Offboarding revokes active use; read of your own content stays owner-gated

- Status: Accepted
- Date: 2026-07-05
- Serves: secure RBAC

## Context

Primitives are workspace-owned and sealed to their workspace (ADR-0003): on
resume a conversation resolves its tools/skills/apps in the workspace it was
created in, and an automation fires walled to its provenance workspace. But
membership in that workspace was validated only **at create**, never at **use** —
so a member removed from a workspace kept active reach into it: resuming an owned
conversation (or a scheduled automation still firing) ran with that workspace's
tools and connectors, as the owner, after they were offboarded.

This contradicted the wall's own safety claim (ADR-0001, ADR-0005): the wall
rests on "the workspace was membership-validated when the session was
established," yet resume/run validated only **ownership**. The permissive stance
that allowed it — "conversations outlive their workspace context" — was a vestige
of an earlier design where conversations lived at flat top-level storage *outside*
any workspace, where "outlive" was literal. Once storage moved into the workspace
(and a workspace delete *archives* its conversations), the stance no longer
matched the model: a conversation was archived when its workspace was deleted, yet
stayed usable after the owner left that workspace.

## Decision

**To *act* in a workspace's resource, you must be a *current* member of that
workspace. Ownership is necessary but not sufficient.** Resuming a conversation
and running an automation both re-check membership of the resource's workspace at
**session establishment** (once per resume / per run, not a per-call scan) and
deny a non-member — the conversation gate throws `403`; the automation run is
recorded as **skipped** so it does not count as a failure and self-heals if the
owner is re-added.

**Reading your own authored content stays owner-gated.** A removed member can
still load and read the conversations and files they authored in that workspace
(`findConversation`, the SSE stream, `GET /v1/files/:id` by id). Active use is
bound to membership; read of one's own content is not. Personal workspaces are
sole-member by construction, so they never gate.

## Consequences

- Offboarding a member from a workspace actually revokes their reach into it —
  no residual ambient authority through an owned conversation or automation.
- The wall's "membership-validated at session establishment" invariant becomes
  true on every door (conversation resume, automation run, and — transitively —
  the files those sessions reach).
- Self-healing: re-adding a member restores their automations and resume access
  with no manual re-enable.
- The read carve-out is a deliberate residual: a departed member retains read of
  their own authored bytes. Revoking read too (plus an audited export/transfer
  flow) is a separate data-governance decision, not a security fix — deferred.
- Files need no independent gate: the only way to reach a workspace's files is
  through a session whose workspace is already membership-checked (chat resume,
  or a validated `X-Workspace-Id` on REST/`/mcp`), so the conversation and
  automation gates cover them.

## Alternatives considered

- **Keep "conversations outlive their workspace context"** — rejected: it grants
  a removed member ambient authority (the workspace's tools/connectors) into a
  boundary they were offboarded from; the stance was a vestige of pre-workspace
  storage and already contradicted archive-on-delete.
- **Revoke read as well, now** — deferred, not rejected: it is a governance
  choice (workspace-owns-the-data vs. you-own-what-you-authored), safely served
  by an explicit audited export rather than standing access, and carries no
  active-authority risk to leave for later.
- **Re-check membership per tool call** — rejected: the wall forbids per-call
  membership scans; the correct altitude is session establishment (resume/run),
  which this uses.
