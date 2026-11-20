# 0074. A workspace's agent is a principal of its own, which a configured service speaks as for a member who asked

- Status: Proposed
- Date: 2026-11-19
- Serves: secure RBAC

## Context

Every run acts as a person. `RunPrincipal.identity` is a `UserIdentity`, its
`ownerId` partitions the conversations, files and tasks the run touches
(ADR-0003, ADR-0004), and the run-start door admits it on that person's
membership of the run's workspace (ADR-0001, ADR-0021). The credentials that
reach the runtime all name a person too: a login session, an MCP
authorization-server token, or an operator app's token issued to a signed-in
user (ADR-0036, ADR-0038). `authenticateRequest` admits no service credential,
because a credential with no person behind it is a member of no workspace.

A shared chat surface does not fit that shape. When a team binds a chat
channel to a workspace and several of its members ask the agent questions in
one thread, a run that acts as whoever asked goes wrong three ways.

- **The answer depends on who asked.** Two members asking the same question
  in the same room reach different tools, because each run carries its
  asker's grants.
- **A person's private reach lands in a room.** A run that acts as its asker
  reaches that person's granted plugins (ADR-0069), and what they return is
  posted where everyone in the room reads it. ADR-0069's rule that a personal
  plugin acts only for its owner holds at the tool and fails at the audience.
- **A thread has no single owner.** One conversation that several members
  continue is owned by none of them, and ADR-0004 makes every primitive
  private to its owner. Keying a conversation per asker splits the thread
  into partial views.

A bridge that calls the runtime as each person must also hold every linked
person's refresh token, so a room's worth of members is a room's worth of
long-lived credentials in one service.

Agent platforms that put an agent in team chat answer this the same way: in a
shared channel the agent acts under its own identity, with reach an
administrator chose for that channel, so what it can do does not depend on
who asked. A person's own accounts stay with direct messages.

The connector principal proposed in #1641 meets the same need from another
side: work the runtime runs for a workspace that no member chose, with no
role, no sign-in, and standing in place of membership.

## Decision

**A workspace may have an agent: a principal of that workspace that is
neither a member nor a user. Only a service the operator configures can speak
as it, only in a workspace whose admin turned that service on, and only for a
member of that workspace who asked.**

### The agent

- **One per workspace.** Its id is derived from the workspace id, in a shape
  no user id can take, so it never collides with a person in any owner
  partition, membership list or log.
- **It is not a person.** It holds no org role, cannot sign in, has no user
  record, and appears in no member list. Its run's prompt preferences
  (timezone, locale) are the workspace's, not the asker's.
- **It has standing in place of membership.** The run-start door admits its
  run only in its own workspace, and only while that workspace has turned on
  the service that asked. It is admitted nowhere else, whatever the URL names.
- **It reaches only what the workspace holds.** The workspace's plugins, under
  the workspace's credentials, and the workspace-scoped platform tools. It
  reaches no personal plugin: it owns none, and a grant is made only by a
  plugin's owner (ADR-0069). It reaches no identity tool of a person
  (`src/tools/identity-sources.ts`), no tool that acts on the caller or the org
  (ADR-0043), and no org administration tool. This holds because of what the
  agent is, not because a list was filtered: there is nothing personal for it
  to reach.
- **It owns what its runs create** in its workspace, under its own owner
  partition, private by ADR-0004 like anything else. Whether and how members
  read and continue an agent-owned conversation is a separate decision. This
  one makes it possible, because the conversation has one owner.

### A service authenticates as itself

- **The credential is one the identity provider issues to the service.** Under
  WorkOS it is a machine-to-machine token from the client-credentials grant. It
  comes from the same AuthKit issuer and key set as the user tokens the
  provider verifies today, with `sub` and `client_id` naming the application
  and `org_id` naming the one organization the application belongs to. The
  existing organization check runs first, so a service credential reaches only
  the tenant whose organization holds the application.
- **The operator lists the services by name.** The provider's configuration
  maps each **agent service** name to its client IDs. A credential whose
  subject is an application is recognised only when its `client_id` is listed.
  Missing or empty, no service credential is recognised, and such a token is
  refused as it is today.
- **A service credential is a new kind of verified caller, not a new grant on
  a user.** It is a member of no workspace and is admitted on no route by its
  own standing. It is admitted only where a request names a workspace and
  speaks as that workspace's agent, and there it resolves to that agent. Every
  other route, and `/mcp/<wsId>`, refuses it. ADR-0038's rule that first-party
  standing has one meaning is unchanged: it governs credentials issued to a
  person.

### A workspace admin turns a service on

- **A workspace setting lists the agent services that may speak as its
  agent.** It is empty when the workspace is created. A workspace admin writes
  it, and there is no org-admin bypass, as for every workspace-scoped write.
- **Removing a service stops it at the next request.** The setting is read on
  every request, never cached into a session.
- **Binding a chat channel to a workspace is the moment to turn it on.** That
  binding is the workspace admin's decision about where the workspace's output
  is published, so it carries the same authority.

### Every request names the member who asked

- **The service names the asker by email**, as the chat vendor verified it.
  The runtime resolves the email to a user of the configured organization and
  admits the request only if that user is a member of the workspace. Any other
  answer is the same refusal a non-member gets. The runtime decides
  membership, and the service only reports who asked.
- **The asker attributes the run and authors its message; it never widens
  reach.** The opening message carries the asker as its author (`RunInput.userId`),
  and the run's record and logs name the agent as principal, the asker, and
  the service. The run reaches what the agent reaches whoever asked.
- **The runtime trusts the service's report of who asked.** That is the trust
  the operator extends by listing the service. A service that misreports can
  make the agent answer as though any member asked, with the agent's reach,
  in workspaces that turned that service on, and nowhere else.

## Consequences

- A shared room gets one agent whose answers do not depend on who asked, and
  a person's private reach cannot enter it.
- A bridge's turns in shared rooms need no per-person token. It holds one
  service credential per tenant, and per-person links remain only where the
  agent acts as the person, in direct messages.
- The runtime gains a second kind of actor beside members. Every place that
  asks who a run is must answer for it: `RunPrincipal`, which today holds a
  `UserIdentity`, the owner partition, the door's membership gate, the tool
  router, prompt composition, usage reporting, and the audit log. A place that
  assumes a person is a gap in the wall, so each is tested with the agent as
  the caller.
- The API guide's statement that no service credential exists changes to:
  one kind exists, and it is admitted only as the agent of a workspace that
  turned its service on.
- Each tenant that uses an agent service needs that service's application in
  its own organization, because a WorkOS machine-to-machine application
  belongs to one organization. Its client ID goes in that tenant's provider
  configuration.
- The OIDC provider has no agent services until it recognises a
  client-credentials token in its own terms (a subject equal to the
  authorized party, `azp`). The `dev` provider verifies every request as the
  local developer and has none.
- The same principal is what a later agent-to-agent door would answer as, so
  that door would add a protocol and no new identity.

### Open

- **Shared sessions.** Members reading and continuing an agent-owned
  conversation, each turn recording its asker, belongs to its own ADR.
- **Spend.** Whether an agent's runs draw on a spend account the workspace
  sets, and who sees its usage. Chat names no account today, and these runs
  name none until that is decided.
- **One kind of non-member principal.** The agent here and the connector
  principal in #1641 share their defining properties: no role, no sign-in,
  standing in place of membership, the workspace's credentials only, and no
  identity tools. Whichever is built second should use the first one's
  principal type, not add another.
- **Trusting the vendor's email.** A chat workspace administered outside the
  tenant can assign an email to an account. Whether the runtime also requires
  the asker's email domain to be one the organization verified is left to the
  first deployment that binds such a workspace.

## Alternatives considered

- **Run as the asker, as the bridge does for direct messages.** Rejected for
  shared rooms by the three failures in the context, and it keeps a refresh
  token per person in the bridge.
- **A bot user: a real account in the organization, made a member of the
  workspace.** Rejected: it is a person-shaped principal with a seat, an org
  role and a way to sign in, it can be granted personal plugins like any
  member, and its membership is the only switch, so turning a service on and
  adding a member become the same act.
- **A shared secret per workspace, issued by the runtime and held by the
  service.** Rejected: a credential the identity provider never issued, whose
  issuance, rotation and revocation would all be the runtime's, against the
  rule that a caller is admitted only through the provider.
- **The runtime mints the service's token, as it mints run credentials for
  the model gateway (ADR-0057).** Rejected: it would make the runtime an
  authorization server for inbound callers, when the provider already issues
  this kind of credential and the organization check already confines it.
- **One agent per organization.** Rejected: it reaches across workspaces, and
  the workspace is the boundary (ADR-0001).
- **Let the agent use the asker's personal plugins after the asker
  consents.** Rejected: the result sits in a room and in a conversation other
  members continue, so one person's consent would publish their data to
  everyone in it.
