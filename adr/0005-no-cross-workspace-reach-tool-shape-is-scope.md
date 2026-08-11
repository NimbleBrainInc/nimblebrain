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

- **Workspace tools** are bare `<source>__<tool>`. The workspace is **not in the
  name** — it comes from the session's membership-validated `workspaceId`, so a
  caller cannot name another workspace at all.
- **Personal connectors** carry a reserved `my_` marker (`my_gmail__send`), which
  is what keeps a workspace `gmail` and the caller's own `gmail` from collapsing
  into one string with two sets of credentials.
- **Identity tools** (kernel sources — conversations, files, automations) are
  **bare** `<source>__<tool>`, owned by the user, outside any workspace.

Enforced at the single `routeToolCall` chokepoint. The `ws_<id>-<source>__<tool>`
form is neither emitted nor routed; a caller presenting one is rejected and told
to re-list. `nb__search`'s discovery corpus is the session's workspace only.

Naming the workspace was the first shape of this decision, and it made another
workspace merely *unreachable*. Dropping the prefix makes it **unnameable**,
which is the stronger property and the reason the current form is bare.

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
