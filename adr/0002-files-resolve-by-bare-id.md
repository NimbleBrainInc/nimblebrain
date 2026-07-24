# 0002. Files resolve by bare id via a workspace locator

- Status: Accepted
- Date: 2026-06-29
- Serves: secure RBAC

## Context

Files are workspace-owned (`workspaces/<wsId>/files/<ownerId>/`), and a file's
id is globally unique. A browser `<img>` GET can't send the `X-Workspace-Id`
header, so the serve path needs to recover the workspace some other way. Earlier
approaches carried it in the URL — the focused workspace (`?ws=`), then the
conversation (`?conversationId=`). The focused workspace is wrong for an
attachment in a conversation the user has open while focused elsewhere; both make
the client supply a coordinate the server must trust.

## Decision

Serve files at bare `GET /v1/files/:fileId`. The server resolves the workspace
from the globally-unique id via a process-wide `FileLocator`, searching **only
the caller's own owner partitions**. The owner partition is both the gate and
the search scope; no client-supplied coordinate exists.

## Consequences

- A request can only ever reach the caller's own bytes — the security property
  is structural, not a check.
- Resolution is a path-only walk, memoised per `(ownerId, fileId)`; a stale memo
  self-heals via a disk re-walk, so it stays correct under `replicas > 1`.
- Files are addressable as context-free primitives (downloads, future Files
  view), not only as conversation attachments.
- Reading a file shared by another owner (future `visibility: shared`) must be a
  separate, visibility-checked path — never a widening of this locator.

## Alternatives considered

- **Client sends the conversation's workspace** — works, but reintroduces a
  client-trusted coordinate and couples a file URL to a conversation.
- **Server-minted capability URL (signed `?sig=`)** — O(1), no index, but adds
  key management + expiry; rejected because file ids must resolve as stable,
  bare, context-free primitives.
