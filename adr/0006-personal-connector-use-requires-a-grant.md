# 0006. Personal-connector use in a shared workspace requires an explicit grant

- Status: Proposed
- Date: 2026-06-29
- Serves: secure RBAC, orchestrate remote MCP

## Context

With general cross-workspace reach removed (ADR-0005), a user's **personal
connector** — a connector they own, installed in their personal workspace
(`ws_user_<userId>`) — can't be used inside a *shared* workspace. That is the one
recurring legitimate crossing: a personal tool used while working in a shared
room. It must be **personal→shared only**, consented, and audited — not a
reopening of the union.

## Decision

A `PersonalConnectorGrant` authorizes a specific personal connector for use in a
specific shared workspace. It is enforced as a **single new gate on the
identity-door branch** of `routeToolCall` (ADR-0005's chokepoint); the
workspace-wall equality check stays absolute. The grant is owned by the
**granting user** (revocation is theirs; it dies when they leave the workspace)
and mirrored under the target workspace for enforcement and admin visibility.
This is the **only** sanctioned cross-scope crossing.

## Consequences

- Personal tools are usable in shared rooms only via explicit, audited consent.
- The crossing is narrow (personal→shared, grant-gated), far narrower than the
  old membership-gated any-to-any union.
- No trust-laundering: the personal connector is never composed into the shared
  workspace's registry.

## Alternatives considered

- **Compose the personal connector into the shared workspace's registry** —
  rejected: trust-laundering (the runtime would silently widen the connector's
  effective scope without consent).
- **Widen the workspace-wall equality check** — rejected: right axis, wrong
  location; the wall must stay absolute.
- **Reopen `users/<userId>/credentials/`** — rejected: that identity-credential
  path is banned; the personal workspace already is the identity proxy.
