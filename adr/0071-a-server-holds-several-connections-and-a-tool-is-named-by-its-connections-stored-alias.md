# 0071. A server holds several connections, and a tool is named by its connection's stored alias

- Status: Proposed
- Date: 2026-11-18
- Serves: orchestrate remote MCP; secure RBAC; manage skills

## Context

A connection carries the `(serverName, workspaceId, principalId, ref)` tuple.
Its OAuth records are credential-store keys `mcp-oauth.<serverName>.<record>`
at its owner's scope (`src/tools/AGENTS.md`), a personal grant names a server,
and a tool's name shape decides its scope (ADR-0005): `gmail__send` is the
workspace's, `my_gmail__send` is the caller's own. Every one of those keys
holds one connection per server per owner.

So no owner can hold two accounts of one system. A person with a Gmail address
for each of two businesses, or a member of two Slack or Linear orgs, connects
one of them. A workspace that runs two Zoom accounts installs one. The `my_`
marker says who owns a tool and nothing about which account it reaches, so it
cannot tell two of a person's own accounts apart even if storage could hold
them.

Whatever tells two connections apart has to work across systems that report
very different things about the account a sign-in reached:

- an OIDC provider reports an email and a name (Google);
- an org or team, with or without the user (Slack, Linear, Ashby);
- a user and an account id from the service's own API, read through the
  catalog's `account` lookup (`src/connectors/catalog/account-lookup.ts`),
  which names one tool and one field (Zoom);
- nothing at all, for a connection authorized by an API key.

Reported identities are also close to each other when they differ:
`mat@example.com`, `mat@example.org` and `mat@example.net` share every part but
the domain.

A tool's name is not private to the model. A task's `allowedTools` names
connectors by `<connector>__*` glob, matched literally (`src/tools/tool-pattern.ts`);
a skill binds to a server's tools by the same globs (ADR-0053, ADR-0068); a
conversation keeps the tools it loaded by name (ADR-0066); and a recorded
conversation event is never rewritten (ADR-0034). A name that changes under
any of them loses a tool.

## Decision

**A server holds any number of connections per owner. A connection has a stable
id and an alias. The alias is assigned when the connection is made, stored, and
never recomputed. A tool's name is `<alias>__<tool>`, and the session resolves
an alias to its connection by lookup, never by reading the name's shape.**

### The connection is the unit

- A connection belongs to one owner (a workspace or a person, ADR-0069) and one
  server, and has an opaque id that satisfies the credential-store key grammar.
- **Credentials key on the connection id**: `mcp-oauth.<connectionId>.<record>`,
  at the owner's scope, as ADR-0027 keeps them.
- The registry addresses a source by connection id. Facts about the server
  (placements, `adminOnlyTools`, hooks, tool policy) still key on the server and
  apply to every connection of it. Facts about one account (tokens, identity,
  `auth_lost`, health) key on the connection.
- "Add another account" on a plugin's server makes a new connection for the same
  owner. Plugins that name the same server for the same owner share that owner's
  connections of it (ADR-0068); a connection belongs to its owner and server,
  not to a plugin.

### An alias is assigned once, from mechanics, never from identity

An alias is lowercase letters, digits and single underscores, starts with a
letter, and is short enough that `<alias>__<tool>` fits the tool-name limit of
every model provider the runtime calls.

1. **The first connection of a server takes the server's short name** (`gmail`).
2. **A later connection takes a label the person gives** at "Add another
   account". The field is prefilled from the identity the new connection
   reports, in a fixed order: org or team name, then email domain, then email,
   then account name. The label is reduced to the alias grammar.
3. **A numeric suffix resolves what nothing else does**: an empty result, or one
   already taken by the same owner, takes the lowest free `_2`, `_3`, ….
4. The alias is stored on the connection. Adding, removing or reconnecting
   another connection never touches it.

The label is display text and the alias is its stored, reduced form. Identity
only prefills the label, so a system that reports nothing still gets a
deterministic alias, and two similar emails never reduce to one alias silently:
the person sees the prefill and the suffix before they confirm.

A removed connection frees its alias, and the next connection that would take
it does.

### Aliases are unique within a session by construction

**A workspace alias is unique within its workspace. A personal alias is unique
among its owner's connections and is written `my_<label>`. A workspace alias
can never begin with `my_`**, nor take an identity source's name, `nb`, or the
retired `ws_` form.

This decides the hard case. A person's `gmail` connection is granted in a
workspace; the workspace later installs its own `gmail`. The person's connection
is aliased `my_gmail` from the moment it is made, in every workspace, and the
workspace's takes `gmail`. They cannot collide, and the workspace's alias is
chosen without reading any member's connections, so it reveals none. Two members
who each hold `my_gmail` never share a session, because a session holds only its
caller's personal connections.

`my_` here is an allocation rule, not a scope marker. Dispatch never strips or
reads it; it reaches the connection the alias is stored on. It keeps the
workspace's names and the person's names in disjoint sets because neither side
can see the other's when it picks. The alias belongs to the connection, not to a
grant, so a person's account carries one name in every workspace where it acts.

What the model sees in a session where both are reachable:

- `gmail__send`, described as the workspace's Gmail, signed in as the
  workspace's account;
- `my_gmail__send`, described as the caller's own Gmail, signed in as
  `mat@example.com`;
- with a second personal account labelled `example.org`, `my_example_org__send`,
  described as the caller's own Gmail, signed in as `mat@example.org`.

In a session where only the personal one is granted, the model sees
`my_gmail__send` alone. In a workspace with no grant, it sees `gmail__send`
alone.

### The model tells accounts apart by description

Each tool's description opens with its connection's label, whose it is
(the workspace's or the caller's), and the identity the connection reports.
The alias is an address; the description is what the model reads to choose.

The catalog's `account` lookup names up to two fields, `user` and `org`, each a
dotted path into the lookup tool's answer, so a connector that knows both
reports both. The OIDC `identity` record supplies `user` where the provider
signs in with one, and a broker supplies what it records. A connector that
reports neither shows its label alone.

### Scope is a lookup

A session's alias table is built when its run starts from:

- the session workspace's connections;
- the caller's own personal connections granted in that workspace;
- the identity sources and `nb`.

`routeToolCall` resolves the alias in that table and then checks owner and grant
as ADR-0006 and ADR-0069 gate them. An alias not in the table is
`UnknownToolSource`. The `ws_<id>-` form is still refused.

ADR-0005's guarantee holds by the table's construction: another workspace's
connections and another member's personal connections are never entered in it,
so no name a caller can write reaches them. They stay unnameable, not merely
unreachable. `/mcp/<wsId>` and `nb__search` read the same table.

This supersedes ADR-0005's rule that a tool name's shape is its scope, and its
`my_` marker as the identity door's selector. ADR-0005's one-workspace session,
its rejection of the `ws_` form, and its single-workspace search corpus stand.
It amends ADR-0069's sentence that a personal connector keeps the `my_` marker.

### A rename rewrites state and leaves records

The owner of a connection (a workspace admin, or the person for their own) may
rename it, which reassigns its label and alias under the same rules.

- **Recorded conversation events keep the name they carry** (ADR-0034). A
  surface that shows a past call shows the recorded name, and the current label
  when the record also carries a connection id.
- **A conversation reads the new name from its next run.** A tool it loaded
  under the old name does not resolve, and the model finds it again by search,
  as it does after any change to the reachable set.
- **Tasks' `allowedTools` are definitions, not records**, so a rename rewrites
  every entry that names the old alias: in every task in the workspace for a
  workspace connection, and in the owner's tasks for a personal one. A task
  never loses its tools to a rename.
- An authored skill's `tool-affinity` is the author's text and is not rewritten.
  The rename names the skills in reach of the renamer whose affinity matches the
  old alias, so they can update them.

### Skills and grants follow the connection

- **A skill bound to a server covers every connection of it in its own install.**
  A plugin skill binds by naming its server (ADR-0068), and the matcher expands
  that binding to `<alias>__*` for each connection of that server, owned by the
  install's owner, in the session's table. A workspace plugin's skill covers the
  workspace's connections and a personal plugin's covers its owner's. One skill
  name in reach from both installs is delivered once and binds both sets, which
  settles ADR-0069's open question about two installs of one plugin. A glob an
  author writes is matched literally and covers only the aliases it spells.
- **A grant is per connection.** A grant names one personal connection and one
  workspace. A personal plugin's skills reach a workspace where any of its
  connections is granted. "Use here" grants the connections a person picks, and
  for a plugin with one connection that is the one choice ADR-0069 describes.
  ADR-0070's request names the plugin, and the client asks which accounts. The
  grant is per connection because what a grant widens is where one credential
  acts, and a person with a work account and a private one decides that per
  account. This amends ADR-0069's "the grant covers the whole plugin"; its
  ownership, revocation and owner-only rules stand.

## Consequences

- One owner can hold two Gmail addresses, two Slack or Linear orgs, or two Zoom
  accounts, and the model picks between them by what each description says.
- Existing names do not change. Each existing connection is given an id at
  migration and the alias it is already called by: the server name for a
  workspace connection, `my_<serverName>` for a personal one. Tasks'
  `allowedTools`, skills' affinity globs and recorded `my_` names in old
  conversations keep matching, with no second spelling read anywhere.
- **Credential keys move.** A boot reconcile copies each `mcp-oauth.<serverName>.*`
  record to `mcp-oauth.<connectionId>.*` at the same scope and then deletes the
  old key; it is idempotent and keyed on the absence of the new one. A refresh
  in flight across it spends a token under one key and saves under the other,
  so the copy runs before any connection starts.
- **Grant records move** from server name to connection id on the owner's
  record, each existing grant becoming a grant of the one connection it covers.
- **The plugin listing changes shape.** #2085's `servers[]` gains `connections[]`,
  each with its id, alias, label, owner, grant state, and reported `user` and
  `org`. A client that reads one account per server shows only the first.
- **The UI gains per-account rows** under each server, "Add another account",
  rename, and per-account "Use here".
- Every tool description carries its connection's label and identity, so an
  identity change (a reconnect as another user) changes the descriptions and
  the cached prefix that holds them (ADR-0066).
- `my_` stays in names. A reader can still mistake it for a scope marker; the
  routing code and `src/orchestrator/AGENTS.md` say that it is an allocation
  rule and that dispatch never reads it.
- A rename breaks an authored skill's literal affinity until its author updates
  it, and the rename names those skills. It breaks a conversation's loaded tool
  until the model searches again.
- A removed connection's alias passes to the next connection that takes it, so
  a task naming it reaches that account. The common case is reconnecting the
  same account; a different one is a different account under an old name.
- The catalog's `account` entries move from `field` to `user` and `org`. The
  catalog is the only writer, so they move in one change.
- **Demand is not measured.** No customer has yet asked to connect two accounts
  of one system. This record fixes the shape so the connection-id keying is not
  designed twice; building it waits for a customer who needs two accounts.

## Alternatives considered

- **Keep `my_` as the scope marker and add numeric suffixes (`my_gmail_2`).**
  The suffix names nothing the model can match to an account, and scope stays a
  property of the name's shape that every door parses.
- **Derive aliases from the reported email.** Identity is absent for some
  systems and near-identical for others, and a reconnect as another user would
  rename every tool.
- **One connection per server, with account switching.** A task or a turn that
  needs both accounts cannot reach both, and a switch is state that one run
  changes under another.
- **Aliases recomputed per session from the set reachable there.** A grant or an
  install elsewhere renames tools in a running conversation and in tasks.
- **Unprefixed personal aliases, fixed per grant, with the workspace install
  avoiding them.** The workspace's alias would reveal that some member holds a
  same-named grant there.
- **Unprefixed personal aliases, renamed when a workspace install collides.** A
  workspace admin's install renames a member's tools in that member's running
  conversations and tasks.
- **Store `allowedTools` as connection ids.** It ends the rewrite on rename, but
  an entry is a glob a person writes and reads, and a list of ids is neither.
