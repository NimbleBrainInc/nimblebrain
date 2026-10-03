# 0044. The URL is the only thing that names a workspace

- Status: Accepted
- Date: 2026-10-03
- Serves: secure RBAC
- Supersedes: the bootstrap default-focus rule of ADR-0037, and the landing preference of ADR-0039

## Context

The web shell is in a workspace only on a `/w/<id>` page. Its home, profile
and org pages are in none, and their tools act on the caller or the org
(ADR-0043). A workspace the server or the client picks for those pages is one
the user did not choose and the page does not act on. Held as ambient client
state, it is also a second answer to "which workspace is this?" beside the URL,
and a request that reads one while labelling its result with the other answers
for the wrong workspace.

## Decision

- **The URL is the only thing that names a workspace.** The server chooses
  none: bootstrap returns the caller's workspaces and no focus, and no
  preference records a workspace to land in. The web shell focuses the
  workspace a `/w/<id>` path names, and nothing on a page loaded outside
  `/w/`. Pages outside `/w/` make no workspace-scoped request, so a focus left
  over from an earlier `/w/` page addresses no request.
- **A user with no workspace gets one at bootstrap**, as ADR-0039 provides:
  an ordinary workspace, named for them, with them as admin. Nothing records
  that it was the first.
- **`/` sends a user in exactly one workspace into it,** and shows anyone else
  their workspaces, each with its unread mark. The choice is derived from
  membership, so it is never stale and never names a workspace the user has
  left.
- **Reopening the app returns to the same place because the URL does:** a
  restored tab or a bookmark carries its `/w/<id>`. The shell remembers no
  last workspace.

## Consequences

- Bootstrap carries no `activeWorkspace` and no shell. The shell reads a
  workspace's placements when a `/w/` page focuses it.
- The home, profile and org pages make no workspace-scoped request; they call
  their tools through `POST /v1/tools/call` (ADR-0043).
- A user in several workspaces who opens `/` sees the home page, not the
  workspace they used last.
- `preferences.defaultWorkspaceId` is no longer read or written. A stored value
  stays in a profile, unread.

## Alternatives considered

- **Remember the last workspace on the server** — rejected: it is the default
  workspace under another name, a server-held answer to a question the URL
  answers.
- **Remember the last workspace in the browser, and open it from `/`** —
  deferred: per-device, and it skips the home page's unread marks, which are
  the reason to land there. It can be added later without the server.
- **Keep the default for the home, profile and org pages only** — rejected:
  those pages act on no workspace, so a workspace there is ambient state with
  nothing to do.
