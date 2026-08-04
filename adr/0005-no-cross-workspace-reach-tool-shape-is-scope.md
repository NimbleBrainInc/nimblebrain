# 0005. No cross-workspace tool reach; a tool name's shape is its scope

- Status: Accepted
- Date: 2026-06-29
- Serves: secure RBAC, orchestrate remote MCP

## Context

Tool discovery and dispatch unioned every workspace the caller belonged to,
gated only by membership — no per-crossing consent, no audit. This is the
dispatch-layer expression of the identity-as-boundary drift (ADR-0001): the
agent could call a tool in any workspace the user was a member of.

## Decision

A session reaches **one workspace plus the caller's identity tools**, and a tool
name's **shape encodes its scope** (two doors):

- **Workspace tools** are namespaced `ws_<id>-<source>__<tool>` and dispatch only
  when `<id>` is the session's workspace.
- **Identity tools** (kernel sources — conversations, files, automations) are
  **bare** `<source>__<tool>`, owned by the user, outside any workspace.

A `ws_<id>-` call for any **other** workspace is **denied, not gated**
(`CrossWorkspaceReachDenied`), enforced at the single `routeToolCall` chokepoint.
`nb__search`'s discovery corpus is the focused workspace only.

## Consequences

- No ambient cross-workspace authority; the wall holds at dispatch, not just in
  the UI.
- The reachable set is deterministic and inspectable from a tool name's shape.
- The membership check happens once when the session is established, not per
  call — there is no per-call workspace scan.

## Alternatives considered

- **Membership-gated union (the lens)** — rejected: the same ambient-authority
  problem as ADR-0001, one layer down.
- **Per-call membership scan** — rejected: redundant; the session is already
  workspace-validated at establishment.
