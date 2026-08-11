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

Every primitive is `(owner, workspace)`, both **path-authoritative**
(ADR-0003), and is private to its owner by that partition alone. The
`<ownerId>` partition is the live boundary in v1 — no field participates in it.

`visibility` is the **reserved forward-compat field** for later widening a
primitive *within* its workspace: `private` (default) | `shared`, with an
absent value reading as `private` (fail-closed). It is declared on `File`
(`src/files/types.ts`) and `Conversation` (`src/conversation/types.ts`), and
**neither written nor read in v1** — the only site touching it deserializes it
on parse. That is groundwork with no attack surface: a field nothing depends on
cannot widen anything by accident.

`Automation` does not declare it. It is private structurally like the others,
and gains the field if and when it needs to widen. `visibility: shared` is
deferred for all three.

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
