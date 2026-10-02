# 0042. A workspace id is generated, and boot refuses any other

- Status: Accepted
- Date: 2026-10-02
- Serves: secure RBAC
- Supersedes: the id-retention rule of ADR-0039

## Context

A workspace id is the handle every surface addresses a workspace by: the
`workspaces/<wsId>/` directory, the `/w/<id>` URL, the `/mcp/<wsId>` endpoint,
and the references other records hold. `WorkspaceStore.create` takes no
caller-chosen id and mints `ws_<16 lowercase hex>`.

Ids of other forms (`ws_<slug>` derived from a name, `ws_user_<userId>`
derived from a user) were kept when minting changed, because they were already
in URLs and client configurations. Keeping them meant two grammars: a narrow
one for what the store creates and a wide, case-insensitive one for what it
loads and what every door accepts. An id derived from a name or a user is the
kind of id the opaque contract forbids, and a wide grammar is what lets one
back in.

## Decision

A workspace id is `ws_` followed by exactly 16 lowercase hex characters,
case-sensitive. That one grammar (`WORKSPACE_ID_PATTERN`) decides what the
store creates, what it loads, and what every door accepts.

Boot refuses to start while `workspaces/` holds a `ws_*` directory with a
`workspace.json` whose name fails the grammar, and names every offender. The
runtime does not rename one: renaming a workspace is an operator step, because
its id is in URLs, external MCP client configurations, and references the
runtime cannot see. After boot, the store refuses such an id like any malformed
one.

## Consequences

- There is one id grammar, mirrored to the web tier by codegen; no door
  accepts an id the store would not create.
- An id carries no name, user, or tenant, so none can be derived or guessed
  from one.
- A deployment holding an id of another form does not start until each such
  workspace is renamed to a generated id, with its references. The error says
  which.
- An archive left under `archived/` by a workspace of another form no longer
  matches the archive grammar, so the Archives tab neither lists nor purges it;
  it is removed by hand.

## Alternatives considered

- **Keep a wide loading grammar** — rejected: two grammars drift, and the wide
  one admits derived ids at every door.
- **Rewrite ids at boot** — rejected: the runtime cannot reach the URLs and
  client configurations that hold an id, so a silent rewrite breaks them.
- **Skip a non-conforming workspace at boot** — rejected: the instance serves
  with that workspace silently missing.
