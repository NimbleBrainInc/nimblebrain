# 0039. The first workspace is an ordinary workspace

- Status: Accepted; the id-retention rule superseded by ADR-0042
- Date: 2026-09-27
- Serves: secure RBAC

## Context

Every user needs a workspace to land in, so one is created for them. That
workspace used to be a kind apart: a "personal" workspace with a deterministic
id derived from the user id, flagged `isPersonal` with an `ownerUserId`, its
membership locked to its owner, and labelled "Home · Personal" in the shell.

The flag made a user's first workspace a different kind of thing for no lasting
reason. Personal connectors, the one feature that needed a per-user home, live
on the identity plane (`IdentityConnectorStore`), not in a workspace. What was
left was a workspace that could never be shared, an id that exposed the user
id, and a set of special cases (connector admission, collision guards, a
membership shortcut, a default for any request that named no workspace) that
every change to workspaces had to remember.

## Decision

A workspace is a workspace, however it came to exist. A user who belongs to no
workspace gets one: an opaque `ws_<16-hex>` id, named for them ("Mat's
workspace"), with them as its admin. Nothing records how it was created, and
members can be added to it like any other.

- Provisioning happens where the shell starts (bootstrap), when the user
  belongs to no workspace — not on every authenticated request. A request that
  names no workspace is a caller error outside dev mode; the server does not
  choose one.
- The workspace a user lands in when nothing names one is a user preference,
  `preferences.defaultWorkspaceId`, set to the workspace provisioned for them.
  It is ignored while they are not a member.
- A conversation's live title is delivered to its owner, not to the members of
  its workspace.
- *Superseded by ADR-0042:* workspaces created as personal ones keep their
  ids.
- The legacy fields are retired at boot: the owner's default is set to that workspace, a name still
  equal to the one provisioning gave it is renamed to the new form, and
  `isPersonal` / `ownerUserId` are removed.

## Consequences

- The first workspace can be shared. When it is, its members use the accounts
  connected in it, as in any workspace: a connector installed in a workspace
  holds one authorization shared by its members. A user who connected accounts
  there while it was private shares them by adding a member. There is no
  consent step for that first share.
- Admin rules are the same everywhere. An admin the owner adds can remove the
  owner, and a workspace left with no admin is recovered by an org admin
  seating an admin with `add_member`.
- *Superseded by ADR-0042:* a workspace provisioned before this keeps a
  `ws_user_<userId>` id. It is in URLs, `/mcp/<wsId>` endpoints configured in
  external clients, and on-disk paths, and ids are opaque, so it stays.
- A bootstrap client reads `activeWorkspace` for the default. `isPersonal`
  remains in the bootstrap payload, true for the default workspace, only until
  its last reader moves off it.

## Alternatives considered

- **Relabel only, keep the sole-owner model** — rejected: the model, not the
  label, is what stops a first workspace from being shared.
- **A deterministic id in the opaque shape (a hash of the user id)** — rejected:
  it keeps a hidden per-user pointer, and a user removed from that workspace
  could never be given another at the same id.
- **Default to the first membership, with no preference** — rejected: a user
  invited to a team workspace before first login would land there instead of
  in the workspace provisioned for them.
- **A consent step before a former personal workspace is first shared** —
  rejected for now; sharing a workspace shares its connections, and that is
  the same for every workspace.
