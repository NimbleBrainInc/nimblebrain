# 0001. The workspace is the authorization boundary, not the identity

- Status: Accepted
- Date: 2026-06-29
- Serves: secure RBAC

## Context

Enforcement had drifted from the **workspace** to the **identity**: a session
could reach the union of every workspace the user belonged to (a "lens" over an
identity-wide reachable set), while the UI still presented the workspace as a
wall — members, roles, isolated credentials, its own URL. Users reason about a
wall; the system enforced a lens. That gap was the source of the recurring
"why can the agent reach outside my workspace?" confusion, and a real
cross-workspace data-reach.

## Decision

The **workspace is the authorization boundary**. A session reaches exactly **one
workspace plus the caller's own identity tools** — never a union across
workspaces. The personal scope is not a special "no workspace" void; it is
itself a workspace (`ws_user_<userId>`), so "everything is workspace-bound" holds
uniformly.

## Consequences

- "Where does this run / what can it touch" has exactly one answer.
- No ambient authority across a boundary users believe is closed.
- Membership in N workspaces does not fuse them into one reachable surface.
- The personal scope needs no special-casing — it is a workspace.

## Alternatives considered

- **Identity-wide reachable set (the lens)** — rejected: it grants ambient
  authority across a boundary users treat as closed, with no per-crossing
  consent or audit.
