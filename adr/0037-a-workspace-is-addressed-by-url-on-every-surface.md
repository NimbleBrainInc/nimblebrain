# 0037. A workspace is addressed by URL on every surface

- Status: Accepted
- Date: 2026-09-25
- Serves: secure RBAC

## Context

ADR-0036 put the workspace in the URL for `/mcp`. The REST surface the web
shell uses still named it in a request header, and that header was a side
channel:

- A browser loads some URLs itself — an `<img src>`, a download link — and
  cannot attach a header to them.
- Whether a route needed the header, accepted it, or ignored it was visible
  only in the route's code. A route that accepted it optionally fell back to
  a workspace of the server's choosing when it was absent.
- A custom header forces a CORS preflight on every call.

A request acts on a workspace, so the workspace is part of what the request
addresses, like any other resource it names.

## Decision

- **A workspace is addressed by URL on every surface.** `/mcp/<wsId>` for MCP,
  `/v1/workspaces/<wsId>/…` for REST. No header, body field or query parameter
  selects a workspace.
- **A route is either workspace-scoped or identity-scoped, and its path says
  which.** A workspace-scoped route lives under the workspace's path. An
  identity-scoped route lives at `/v1/…` and names no workspace: it acts on the
  caller (bootstrap, the event stream) or on a primitive its own id locates
  (a conversation, a file). A route that sometimes needs a workspace is two
  routes, or a workspace-scoped one.
- **One admission rule for the workspace in a path.** The id's shape is
  checked before any lookup; membership is checked on every request with exact
  id equality; a malformed id, an unknown workspace and a workspace the caller
  does not belong to get one answer. Both surfaces call the same code.
- **The server never chooses a workspace for a request.** Bootstrap is the one
  place it chooses anything: a default focus for the web shell, which the URL
  the user is on overrides.

## Consequences

- One way to address a workspace, readable from the route table. A link to a
  workspace-scoped resource carries its workspace, and a link to an
  identity-scoped one does not need to.
- Every REST client changes its URLs at once; the old paths are gone rather
  than redirected. A browser tab running the previous web build calls removed
  routes until it reloads.
- The custom header's preflight had also kept another origin's form post from
  reaching a workspace route with the session cookie. That protection is now
  explicit: a browser write under `/v1/workspaces/` from another origin is
  refused unless the CORS allowlist names that origin.
- The internal connector token carries no identity, so it is a member of no
  workspace and reaches no workspace route outside dev mode.
- The web client builds each workspace path from its active workspace, per
  request, and refuses to send one when it has none.

## Alternatives considered

- **Keep the header for REST, the path for MCP** — rejected: two ways to name a
  workspace, and a header a browser cannot send on the requests it makes itself.
- **Redirect the old paths** — rejected: a redirect needs the workspace the old
  path lacked, so it would have to read the header or choose a default, which
  is what this removes.
- **Fall back to the personal workspace when none is named** — rejected: a
  default the caller did not choose, which ADR-0036 already refused for `/mcp`.
- **Put every route under a workspace for uniformity** — rejected: an
  identity-scoped route would then check membership of a workspace it does not
  act on, and a conversation or file would answer at as many paths as the
  caller has workspaces.
