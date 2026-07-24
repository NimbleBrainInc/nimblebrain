# 0004. Private by default; visibility is a mutable field, sharing deferred

- Status: Accepted
- Date: 2026-06-29
- Serves: secure RBAC

## Context

Primitives need a uniform answer to "who can see this?" that composes across
conversations, files, and automations. Sharing within a workspace is wanted
eventually, but v1 does not need it — and shipping a half-built sharing read
path would be attack surface with no consumer.

## Decision

Every primitive carries `(owner, workspace, visibility)`. `owner` and
`workspace` are **path-authoritative** (ADR-0003). `visibility` is a **mutable
field**, defaulting to `private`; an absent value reads as `private`
(fail-closed). v1 is **private-only**: the field is written and never read —
groundwork with no attack surface. Sharing *within* a workspace (`visibility:
shared`) is deferred.

## Consequences

- Privacy is structural (the owner sub-partition), not a check.
- Turning on sharing later is a **field flip**, not a data relocation.
- v1 ships strictly fail-closed; `shared` never crosses the workspace wall when
  it lands ("shared" means "to this workspace," never beyond).

## Alternatives considered

- **Encode visibility in the path** (so sharing is a move) — rejected: churns
  storage on every visibility change.
- **Build sharing now** — deferred: no v1 consumer; it would add an unread
  cross-owner read path (attack surface) before it's needed.
