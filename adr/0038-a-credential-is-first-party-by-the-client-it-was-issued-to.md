# 0038. A credential is first-party by the client it was issued to

- Status: Accepted
- Date: 2026-09-26
- Serves: secure RBAC

## Context

ADR-0036 split credentials in two. A token from the MCP authorization server is
a resource token, valid only at the `/mcp/<wsId>` its `aud` names and on no
`/v1/*` route. The instance's own login session is first-party: bound to no
resource, admitted on every route, gated by membership. The provider decided
which kind by issuer alone, so every authorization-server token was a resource
token.

The operator's own apps can also sign users in through the authorization
server. A chat-channel bridge does this and then calls the REST API as the
user. It requests no resource, so its token's `aud` is the environment's client
ID, and every call it made was refused.

The audience cannot tell that app apart from an external MCP client. A client
that refreshes a token without `resource` gets the same `aud`, so admitting
that audience on `/v1/*` would give every MCP client the REST API. What does
differ is the client the token was issued to: the authorization server signs
it into the token's `client_id` claim.

## Decision

- **A credential's audience says where it may be used; the client it was
  issued to says whose app holds it.** Neither stands in for the other.
- **Only a configured first-party client gets first-party standing.** An
  authorization-server token is first-party if and only if its signed
  `client_id` is in the provider's configured list of first-party client IDs.
  Any other token from the authorization server is a resource token, exactly
  as ADR-0036 describes.
- **The list is the provider's configuration, and it fails closed.** Missing
  or empty, no authorization-server token is first-party. The audience never
  decides standing, whatever it contains.
- **First-party means one thing.** Such a token carries the same grant as the
  login session: admitted on every route, with workspace membership as the
  gate. There is no third kind of grant. The provider classifies the token,
  and the provider-independent admission rule and `/mcp` code do not change.

## Consequences

- An operator's app, such as a channel bridge, reaches the REST API and every
  workspace MCP endpoint its user is a member of, once its client ID is
  configured.
- Adding a client ID to the list gives that app's users full first-party
  reach. The list names only apps the operator runs.
- A non-member gets the same answer as an unknown workspace, whichever kind
  of credential they hold.
- A provider that is not an authorization server has no such list. If one
  became an authorization server, its equivalent claim would decide the same
  question (for OpenID Connect, `azp`, the party the token was issued to).

## Alternatives considered

- **Admit the environment's client ID as an audience on `/v1/*`.** Rejected:
  a token an MCP client refreshes without `resource` carries that audience,
  so it would admit every MCP client.
- **A new grant kind for operator apps.** Rejected: its reach would be
  first-party reach, so a second name adds a branch to every admission check
  and changes nothing it admits.
- **Require the app to request a resource.** Rejected: a resource token is
  valid only at `/mcp/<wsId>`, and the REST API is no protected resource, so
  no resource value makes a REST call valid.
