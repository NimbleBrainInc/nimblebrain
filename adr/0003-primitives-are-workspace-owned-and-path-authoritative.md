# 0003. Primitives are workspace-owned and path-authoritative

- Status: Accepted
- Date: 2026-06-29
- Serves: secure RBAC

## Context

Conversations, files, and automations were identity-partitioned or carried a
soft, mutable `workspaceId` breadcrumb. Under application-level auth (no
row-level security), a mutable field is not a boundary — a query can read across
it, and the field can drift from where the data actually lives.

## Decision

Every primitive lives at `workspaces/<wsId>/<primitive>/<ownerId>/`. The **path
carries the two immutable coordinates** — the **workspace** (the wall) and the
**owner** (a privacy sub-partition). The boundary is therefore **structural**: a
query physically cannot reach across it, rather than relying on a runtime check.
`workspaceId`/`ownerId` on the record are denormalised conveniences; the path is
authoritative.

## Consequences

- "Helix's stuff" is `ls workspaces/ws_helix/`; workspace delete is a subtree
  archive (archive-then-cascade), not a scan-and-delete.
- A user's lists are a directory listing, not a scan-and-filter.
- No dangling cross-workspace references — a primitive can't outlive its
  workspace as a fossil.
- The cost, stated honestly: this optimises **workspace** lifecycle at the
  expense of making **user** lifecycle (GDPR delete-user) a cross-workspace
  sweep. Workspaces are the boundary and the more frequent churn event, so this
  is the right thing to make cheap.

## Alternatives considered

- **Flat / identity-partitioned stores + a `workspaceId` field** — rejected: the
  field drifts from the data and is not a boundary under app-level auth.
