# 0036. An MCP connection is addressed to one workspace by URL

- Status: Accepted
- Date: 2026-09-25
- Serves: secure RBAC, orchestrate remote MCP

## Context

A session reaches one workspace (ADR-0005). External MCP clients, such as a
hosted assistant's custom connectors, accept only a URL: they cannot send a
header naming the workspace. And a token an MCP client obtains from an
authorization server is, per the MCP authorization spec, bound to a resource
(RFC 8707 `resource`, RFC 9728 metadata) — which is only meaningful if the
resource names something narrower than the whole instance.

The authorization server echoes the client's `resource` verbatim into `aud`,
mints for sub-paths under a registered indicator, and lets a refresh token move
between resources under the same host. So `aud` can prove where a token was
minted for, but not who may use a workspace.

## Decision

- **The workspace is in the URL.** A workspace's MCP endpoint is
  `<publicOrigin>/mcp/<wsId>`, and that string, built from configuration and
  never from request headers, is the resource's canonical identifier. Bare
  `/mcp` is refused; no workspace is ever chosen by default.
- **A token is valid only for the resource it was minted for.** A token from the
  MCP authorization server is admitted at `/mcp/<wsId>` only when its `aud`
  contains the canonical URL exactly — no prefix match, no normalization, no
  workspace parsed out of it — and on no `/v1/*` route. A first-party credential
  (the instance's own login session) is bound to no resource and is not subject
  to the rule. The provider reports which kind a verified token is; one
  provider-independent check (`grantAdmits`) applies the rule.
- **Membership, not audience, authorizes.** Every request to `/mcp/<wsId>`
  checks membership of `<wsId>`, fails closed, and answers a non-member exactly
  as it answers an unknown workspace.
- **A session is bound to (identity, workspace).** A session id presented at
  another workspace's URL, or by another identity, is answered as unknown.
- **Discovery is per workspace.** Each endpoint's metadata lives at the RFC 9728
  path for its URL, and a 401 points there. The root document is absent: the
  origin is no resource that accepts a token.

## Consequences

- A URL-only client can reach exactly one workspace, and a token leaked from one
  workspace's connection is refused everywhere else.
- Existing connections, and tokens minted for the origin, stop working; users
  reconnect with the workspace's URL.
- Reaching two workspaces takes two connections, and switching workspace in the
  web app opens a new bridge session.
- The authorization server must have a resource indicator covering
  `<origin>/mcp/*` for every public host, custom domains included, or it ignores
  `resource` and every token is refused. That is deployment configuration the
  runtime cannot check.

## Alternatives considered

- **Keep the workspace in a request header** — rejected: URL-only clients cannot
  send one, and a token bound to the origin would be valid for every workspace.
- **Match `aud` by prefix, or parse the workspace out of it** — rejected: the
  authorization server mints for sub-paths, so anything looser than equality
  admits a token minted for another resource.
- **Treat `aud` as authorization** — rejected: a refresh token can move to any
  workspace URL under the host, so the audience says nothing about membership.
- **Serve identity tools at bare `/mcp`** — rejected: it keeps a second, broader
  resource alive and a default the caller did not choose.
