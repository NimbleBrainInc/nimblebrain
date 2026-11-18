# 0069. A plugin belongs to a workspace or a person, and a personal plugin acts only where its owner grants it

- Status: Proposed
- Date: 2026-11-18
- Serves: secure RBAC; manage skills; orchestrate remote MCP

## Context

ADR-0068 makes a plugin the unit of install: a bundle of servers and skills,
resolved from a catalog, reconciled from a declared list, and recorded in a
lock. It describes installed state as what a workspace has.

Plugins have a second owner. A person connects their own Gmail or their own
calendar: the credential is theirs, stored at `user` credential scope outside
any workspace, and it follows them into every workspace they belong to
(`src/tools/AGENTS.md`). A workspace's Gmail is a different thing with the same
server: one sign-in, held by the workspace, which every member's runs act
through. Which of the two a plugin is decides whose account the agent acts as,
and so who has to agree to it acting.

ADR-0006 gates the one crossing between these owners: a personal connector's
tools reach a workspace only under a grant its owner makes for that workspace,
and the connector is never composed into the workspace's registry. The grant
is per connector. A plugin also carries skills, and under ADR-0068 a skill that
names no server loads through the ordinary channels (ADR-0010). Installed with
a person's plugin, such a skill sits with the person's other skills, and the
`user` tier loads in every workspace the person enters (ADR-0034). So a
personal plugin's guidance would reach workspaces where its connector was never
granted.

The grant is written by `nb__manage_connectors`. In a conversation the model
can call that tool; only unattended runs are refused it
(`src/tools/unattended-policy.ts`). Granting widens where a person's
credential acts, so a model that could grant could widen it without the person
deciding.

## Decision

**A plugin is installed for a workspace or for a person. A personal plugin acts
in a workspace only while its owner grants it there, and the grant covers the
whole plugin.**

### Two owners, one mechanism

- **A workspace plugin** is in the workspace's declared list. Its servers'
  credentials are held at `workspace` scope, and every member's runs in that
  workspace reach it.
- **A personal plugin** is in its owner's declared list. Its servers'
  credentials are held at `user` scope, and only its owner's runs reach it.

Both lists are reconciled and locked as ADR-0068 describes. The owner is the
list the plugin is declared in; nothing on the plugin, the catalog, or the
artifact claims it.

**A server installed for a workspace and for a person is two connections**,
each authorized with its owner's credential. ADR-0068's sharing of one
connection between plugins applies only between plugins with the same owner.
A personal connector's tools keep the reserved `my_` marker (ADR-0005), so the
two never share a name.

**A plugin is installable for a person only when each of its servers can hold
a credential that is the person's own.** A server that authorizes only with a
credential the operator or the workspace configures is installable for a
workspace and not for a person, and the install says so before it starts.

### A grant is per plugin, per workspace

A grant names one personal plugin and one workspace. While it stands:

- the plugin's connectors are reachable from its owner's runs in that
  workspace, through the identity door, as ADR-0006 gates them;
- the plugin's skills reach those runs, whether they name a server or not.

Without it, neither reaches the workspace. A skill installed with a personal
plugin is not a `user`-tier skill: it is stored with the plugin's install and
is collected for a workspace only where the plugin is granted. A skill a person
authors on its own stays in the `user` tier and follows them everywhere, since
it carries guidance and no authority.

No workspace is granted by default, including the first workspace a person is
given (ADR-0039). Installing a plugin from inside a workspace grants it there in
the same act, because the person chose that workspace by installing there.

A grant is owned by the person who made it and is stored on their record,
naming the workspace. It ends when they revoke it, when they leave the
workspace (ADR-0007), or when they remove the plugin.

### Only the owner grants

A grant is written only from its owner's answer in a first-party client
(ADR-0038). When a model calls for a grant, the runtime asks the person, and
the call returns what they answered; it never grants on the model's say. A
revoke narrows reach and may be made by the owner or on their behalf in their
own conversation.

### What a grant does not change

- **Other members gain nothing.** A personal plugin's tools are never in the
  workspace's registry, and another member's call to a `my_` tool resolves to
  that member's own plugin or to nothing.
- **What the plugin produces is the workspace's.** Conversations, files and
  task results made with it are workspace-owned and private to their owner by
  default (ADR-0003, ADR-0004), as anything else made there is.
- **A task uses it as its owner.** A task in a workspace runs as the person who
  owns it, so it reaches that person's plugins granted there. When the grant
  ends, a run whose `allowedTools` names the plugin's tools is refused naming
  them, as a run with an unreachable listed tool is today.

### Every listing says whose it is

The runtime's plugin listing carries, for each plugin, its owner (workspace or
person), whether it is granted in the requested workspace, and the account each
of its servers is signed in as, from the identity the connection's OAuth
records hold. A client shows a plugin by these facts and needs no rule of its
own to tell a personal plugin from a workspace one.

## Consequences

- One rule explains reach: a plugin that uses your account acts only where you
  turn it on. The workspace's plugins and your granted plugins are what the
  agent has in a workspace.
- A personal plugin's guidance stops leaking into workspaces it was not granted
  to. The cost is a new skill store beside the `user` tier, collected per
  workspace by grant, and one more pool for the skill index and the most-local
  rule (ADR-0015, ADR-0019) to order.
- The grant moves from a connector to a plugin. A plugin with several servers is
  granted once, and existing per-connector grants become grants of the plugins
  that hold those connectors.
- A model in a conversation can propose a grant but cannot make one, so a
  conversation that needs a person's plugin pauses for their answer.
- A plugin whose servers take only operator or workspace credentials cannot be
  installed for one person. The person needs a workspace to install it in, or the
  server needs a per-person sign-in.
- The same plugin can be installed for a workspace and for a person at once. Both
  appear, each with its owner and account, and the two connections never merge.

### Open

- Which of two installs of the same plugin wins a skill name when both are in
  reach, and whether each skill should bind to its own install's connector
  namespace (`gmail` and `my_gmail`) rather than collide on one name.
- Whether an organization's policy (ADR-0068) can require or forbid personal
  install of a plugin separately from workspace install.

## Alternatives considered

- **Keep the grant per connector, and let a personal plugin's skills follow the
  person.** Guidance for a tool the workspace cannot reach composes there,
  costing tokens and steering the model toward a tool it does not have.
- **Personal plugins usable everywhere their owner is a member, with no grant.**
  A person's credential would act in every shared workspace by default, and
  joining a workspace would widen it without a decision. ADR-0006 rejects that.
- **Compose a granted personal plugin into the workspace's registry.** Other
  members would reach one person's account. ADR-0006 rejects it as
  trust-laundering.
- **Let the model grant in a conversation it is already in.** The person would
  learn of the widening after the fact, if at all.
- **A personal workspace that holds a person's plugins.** It makes reach depend
  on which workspace a plugin sits in rather than on whose credential it uses,
  and every workspace is an ordinary one (ADR-0039).
